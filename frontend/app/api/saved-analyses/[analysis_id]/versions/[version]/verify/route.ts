// SPDX-License-Identifier: Apache-2.0

import { withPermission } from '@/auth/with-auth';
import { proxyToBackend } from '@/auth/proxy-backend';

// Records the caller as the verifier, so the user id is forwarded.
export const POST = withPermission({ analysis: ['manage'] })((req, { user }) =>
	proxyToBackend(req, { userId: user.id }),
);
