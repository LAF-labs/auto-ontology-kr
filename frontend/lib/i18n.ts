// SPDX-License-Identifier: Apache-2.0

import ko from '@/locales/ko';

/**
 * UI language, fixed at build time per deployment (`NEXT_PUBLIC_UI_LOCALE=ko`).
 * Anything else keeps the upstream English UI byte for byte.
 */
export const UI_LOCALE: 'en' | 'ko' = process.env.NEXT_PUBLIC_UI_LOCALE === 'ko' ? 'ko' : 'en';

const DICTIONARIES: Record<'en' | 'ko', Readonly<Record<string, string>>> = { en: {}, ko };
const dictionary = DICTIONARIES[UI_LOCALE];

/**
 * Translate a UI string. The English text is the key, so call sites stay
 * readable and a missing translation falls back to the original English.
 *
 * `{name}` placeholders are filled from *vars*:
 * `tr('Showing {count} results', { count: 3 })`.
 */
export function tr(text: string, vars?: Readonly<Record<string, string | number>>): string {
	const translated = dictionary[text] ?? text;
	if (!vars) return translated;
	return translated.replace(/\{(\w+)\}/g, (match, key: string) =>
		key in vars ? String(vars[key]) : match,
	);
}
