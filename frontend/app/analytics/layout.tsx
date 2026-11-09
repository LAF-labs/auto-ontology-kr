// SPDX-FileCopyrightText: Copyright (c) 2024-2026, NVIDIA CORPORATION & AFFILIATES.
// All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from 'next';
import { tr } from '@/lib/i18n';

export const metadata: Metadata = {
	title: tr('Analytics'),
};

export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
	return children;
}
