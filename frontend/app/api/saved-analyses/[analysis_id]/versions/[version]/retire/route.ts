// SPDX-License-Identifier: Apache-2.0

import { withPermission } from '@/auth/with-auth';
import { proxyToBackend } from '@/auth/proxy-backend';

export const POST = withPermission({ analysis: ['manage'] })((req, { user }) =>
	proxyToBackend(req, { userId: user.id }),
);
