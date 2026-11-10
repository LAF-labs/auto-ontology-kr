// SPDX-License-Identifier: Apache-2.0

import { withPermission } from '@/auth/with-auth';
import { proxyToBackend } from '@/auth/proxy-backend';

// Re-register the Custom Analyses copies of verified saved analyses (after a
// semantic reset, or to retry a failed copy). Mechanical, so manage suffices.
export const POST = withPermission({ analysis: ['manage'] })((req) => proxyToBackend(req));
