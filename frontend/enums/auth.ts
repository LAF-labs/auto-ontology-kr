// SPDX-FileCopyrightText: Copyright (c) 2024-2026, NVIDIA CORPORATION & AFFILIATES.
// All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Application roles. Mirrors the `role` column Better Auth's admin plugin manages. */
export enum Role {
	Admin = 'admin',
	Viewer = 'viewer',
	/** Viewer plus saving draft saved analyses (no verify, no other writes). */
	AnalysisEditor = 'analysis_editor',
	/** AnalysisEditor plus verifying and retiring saved-analysis versions. */
	AnalysisReviewer = 'analysis_reviewer',
}
