// SPDX-License-Identifier: Apache-2.0

import { withPermission } from '@/auth/with-auth';
import { proxyToBackend } from '@/auth/proxy-backend';

// analysis:verify, not manage: a token that drafts analyses cannot confirm them.
export const POST = withPermission({ analysis: ['verify'] })((req, { user }) =>
	proxyToBackend(req, { userId: user.id }),
);
