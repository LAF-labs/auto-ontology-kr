// SPDX-License-Identifier: Apache-2.0

import { withPermission } from '@/auth/with-auth';
import { proxyToBackend } from '@/auth/proxy-backend';

// One dashboard screen in one call. A read, like a single run.
export const POST = withPermission({ analysis: ['read'] })((req) => proxyToBackend(req));
