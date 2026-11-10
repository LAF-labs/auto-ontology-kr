// SPDX-License-Identifier: Apache-2.0

import { withPermission } from '@/auth/with-auth';
import { proxyToBackend } from '@/auth/proxy-backend';

// Running is a read: dashboards call this with a viewer token.
export const POST = withPermission({ analysis: ['read'] })((req) => proxyToBackend(req));
