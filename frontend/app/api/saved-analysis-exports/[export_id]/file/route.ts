// SPDX-License-Identifier: Apache-2.0

import { withPermission } from '@/auth/with-auth';
import * as streaming from '@/auth/proxy-backend-stream';

// The exported file, streamed through (docs/saved-analyses.md §15).
// analysis:export. 410 once retention has deleted it.
export const GET = withPermission({ analysis: ['export'] })((req, { user }) =>
	streaming.proxyToBackend(req, { userId: user.id }),
);
