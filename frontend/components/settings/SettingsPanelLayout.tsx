// SPDX-FileCopyrightText: Copyright (c) 2024-2026, NVIDIA CORPORATION & AFFILIATES.
// All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { type ReactNode } from 'react';
import { BackPanelLayout } from '@/common/BackPanelLayout';
import { SettingsNav } from '@/components/settings/SettingsNav';
import { tr } from '@/lib/i18n';

type SettingsPanelLayoutProps = {
	children: ReactNode;
	/** Passed straight to the nav, which drops Connections when it is set. */
	connectionsEnvManaged: boolean;
};

export const SettingsPanelLayout = ({
	children,
	connectionsEnvManaged,
}: SettingsPanelLayoutProps) => (
	<BackPanelLayout
		panelAriaLabel={tr('Settings sections')}
		expandAriaLabel={tr('Expand settings menu')}
		collapseAriaLabel={tr('Collapse settings menu')}
		panel={<SettingsNav connectionsEnvManaged={connectionsEnvManaged} />}
	>
		{children}
	</BackPanelLayout>
);
