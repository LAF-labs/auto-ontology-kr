// SPDX-FileCopyrightText: Copyright (c) 2024-2026, NVIDIA CORPORATION & AFFILIATES.
// All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { tr } from '@/lib/i18n';
/** Connector kinds supported in the new-connection wizard. */
export enum ConnectionType {
	DATABRICKS = 'databricks',
	POSTGRESQL = 'postgresql',
	MYSQL = 'mysql',
	SNOWFLAKE = 'snowflake',
	HEAVYDB = 'heavydb',
	KYUUBI = 'kyuubi',
	TRINO = 'trino',
	CLICKHOUSE = 'clickhouse',
}

export const connectionDisplayName: Record<ConnectionType, string> = {
	[ConnectionType.DATABRICKS]: 'Databricks',
	[ConnectionType.POSTGRESQL]: 'PostgreSQL',
	[ConnectionType.MYSQL]: 'MySQL',
	[ConnectionType.SNOWFLAKE]: 'Snowflake',
	[ConnectionType.HEAVYDB]: 'HeavyDB',
	[ConnectionType.KYUUBI]: 'Apache Kyuubi',
	[ConnectionType.TRINO]: 'Trino',
	[ConnectionType.CLICKHOUSE]: 'ClickHouse',
};

export const isConnectionType = (value: string | null | undefined): value is ConnectionType =>
	typeof value === 'string' && (Object.values(ConnectionType) as string[]).includes(value);

export type ConnectionFieldKey =
	| 'host'
	| 'http_path'
	| 'port'
	| 'account'
	| 'warehouse'
	| 'user'
	| 'password'
	| 'private_key'
	| 'private_key_passphrase'
	| 'database'
	| 'protocol'
	| 'ssa_url'
	| 'truststore'
	| 'truststore_file'
	| 'truststore_password'
	| 'schema'
	| 'http_scheme'
	| 'sso_federation'
	| 'table_allow_regex'
	| 'table_deny_regex';

export type ConnectionField = {
	key: ConnectionFieldKey;
	label: string;
	placeholder?: string;
	secret?: boolean;
	/** Optional fields are not required to enable Test/Create. */
	optional?: boolean;
	/** Sent with the connection test only; stripped before the connection is created. */
	testOnly?: boolean;
	/** Rendered as a checkbox and sent as a boolean rather than a string. */
	boolean?: boolean;
	/** Rendered as a textarea. Needed for pasted PEM keys, which span many lines. */
	multiline?: boolean;
	/** Rendered as a file picker; the value is the file's base64-encoded bytes. */
	file?: boolean;
	/** `accept` attribute for a file field. */
	fileAccept?: string;
	/** Helper text shown under the field. */
	hint?: string;
};

/**
 * Fields where supplying any one satisfies the requirement, so none of them can
 * be marked required on its own.
 *
 * Snowflake accounts that enforce MFA reject password sign-in for person users
 * and forbid passwords on service users, leaving a key pair as the only usable
 * credential. Accounts without that enforcement still take a password, so the
 * form has to accept either.
 */
export const CONNECTION_EITHER_FIELDS: Partial<Record<ConnectionType, ConnectionFieldKey[]>> = {
	[ConnectionType.SNOWFLAKE]: ['password', 'private_key'],
};

/** Form fields rendered per connector type. `database` is the connection identity. */
export const CONNECTION_FIELDS: Record<ConnectionType, ConnectionField[]> = {
	[ConnectionType.DATABRICKS]: [
		{
			key: 'host',
			label: tr('Server Hostname'),
			placeholder: 'dbc-a1b2345c-d6e7.cloud.databricks.com',
		},
		{
			key: 'http_path',
			label: tr('HTTP Path'),
			placeholder: '/sql/1.0/warehouses/a1b234c567d8e9fa',
		},
		{ key: 'password', label: tr('Access Token'), secret: true },
		{ key: 'database', label: tr('Catalog'), placeholder: 'main' },
		{
			key: 'schema',
			label: tr('Schema'),
			placeholder: tr('Leave Empty to Choose from a List'),
			hint: tr(
				'Ingest only this schema. The connection test verifies it exists, and the schema selection step is skipped. Leave empty to pick schemas from a list instead.',
			),
			optional: true,
			testOnly: true,
		},
		{
			key: 'sso_federation',
			label: tr('Authenticate as Signed-In User (SSO)'),
			hint: tr(
				'Chat queries run with the signed-in user’s own Databricks privileges instead of the access token above. Requires a Databricks federation policy trusting your SSO issuer. Ingestion always uses the access token.',
			),
			optional: true,
			boolean: true,
		},
	],
	[ConnectionType.POSTGRESQL]: [
		{ key: 'host', label: tr('Host'), placeholder: 'localhost' },
		{ key: 'port', label: tr('Port'), placeholder: '5432' },
		{ key: 'user', label: tr('User'), placeholder: 'postgres' },
		{ key: 'password', label: tr('Password'), secret: true },
		{ key: 'database', label: tr('Database'), placeholder: 'my_database' },
	],
	[ConnectionType.MYSQL]: [
		{ key: 'host', label: tr('Host'), placeholder: 'localhost' },
		{ key: 'port', label: tr('Port'), placeholder: '3306', optional: true },
		{ key: 'user', label: tr('User'), placeholder: 'root' },
		{ key: 'password', label: tr('Password'), secret: true },
		{ key: 'database', label: tr('Database'), placeholder: 'my_database' },
	],
	[ConnectionType.SNOWFLAKE]: [
		{ key: 'account', label: tr('Account'), placeholder: 'xy12345.us-east-1' },
		{ key: 'warehouse', label: tr('Warehouse'), placeholder: tr('COMPUTE_WH') },
		{ key: 'user', label: tr('User') },
		{
			key: 'password',
			label: tr('Password'),
			secret: true,
			optional: true,
			hint: tr(
				'Leave empty and paste a private key below if the account enforces MFA, which blocks password sign-in for unattended services.',
			),
		},
		{
			key: 'private_key',
			label: tr('Private Key (PEM)'),
			placeholder: '-----BEGIN PRIVATE KEY-----',
			secret: true,
			optional: true,
			multiline: true,
			hint: tr(
				'Key-pair authentication. Paste the full PEM for a key registered on the Snowflake user. Used instead of a password.',
			),
		},
		{
			key: 'private_key_passphrase',
			label: tr('Private Key Passphrase'),
			secret: true,
			optional: true,
			hint: tr('Only needed if the private key above is encrypted.'),
		},
		{ key: 'database', label: tr('Database'), placeholder: tr('MY_DATABASE') },
	],
	[ConnectionType.HEAVYDB]: [
		{ key: 'host', label: tr('Host'), placeholder: 'localhost' },
		{ key: 'port', label: tr('Port'), placeholder: '6274', optional: true },
		{ key: 'user', label: tr('User'), placeholder: 'admin' },
		{ key: 'password', label: tr('Password'), secret: true },
		{ key: 'database', label: tr('Database'), placeholder: 'heavyai' },
		{ key: 'protocol', label: tr('Protocol'), placeholder: 'binary', optional: true },
	],
	[ConnectionType.KYUUBI]: [
		{ key: 'host', label: tr('Host') },
		{ key: 'port', label: tr('Port'), optional: true },
		{
			key: 'user',
			label: tr('Generate Token Client ID'),
			hint: tr(
				'The SSA client ID for a service account, or your account name when using a pasted token.',
			),
		},
		{
			key: 'password',
			label: tr('Generate Token Client Secret'),
			secret: true,
			hint: tr(
				'The SSA client secret when a token URL is set below, otherwise a JWT copied from the data platform profile page.',
			),
		},
		{
			key: 'ssa_url',
			label: tr('Generate Token URL'),
			optional: true,
			hint: tr(
				'Enables service-account auth. Tokens expire hourly, so this lets the connector mint fresh ones instead of failing after an hour.',
			),
		},
		{ key: 'database', label: tr('Catalog') },
		{
			key: 'truststore_file',
			label: tr('Truststore (JKS)'),
			file: true,
			fileAccept: '.jks,.keystore,.truststore',
			optional: true,
			hint: tr(
				'Upload the CA truststore. Needed when the server does not already trust the internal CA.',
			),
		},
		{
			key: 'truststore_password',
			label: tr('Truststore Password'),
			secret: true,
			optional: true,
		},
	],
	[ConnectionType.TRINO]: [
		{ key: 'host', label: tr('Host'), placeholder: 'trino.example.com' },
		{ key: 'port', label: tr('Port'), placeholder: '8080', optional: true },
		{
			key: 'user',
			label: tr('User'),
			placeholder: 'analyst',
			hint: tr(
				'On an unauthenticated cluster this is only the identity Trino records against the query.',
			),
		},
		{
			key: 'password',
			label: tr('Password'),
			secret: true,
			optional: true,
			hint: tr(
				'Leave empty for an unauthenticated cluster. A password switches the connection to HTTPS, which Trino requires before it will accept one.',
			),
		},
		{ key: 'database', label: tr('Catalog'), placeholder: 'hive' },
		{
			key: 'schema',
			label: tr('Schema'),
			placeholder: tr('Leave Empty to Choose from a List'),
			hint: tr('Ingest only this schema. Leave empty to pick schemas from a list instead.'),
			optional: true,
		},
	],
	[ConnectionType.CLICKHOUSE]: [
		{
			key: 'host',
			label: tr('Host'),
			placeholder: 'clickhouse.example.com',
			hint: tr(
				'A pasted ClickHouse Cloud endpoint may include https://; the scheme is kept as the transport.',
			),
		},
		{
			key: 'port',
			label: tr('Port'),
			placeholder: '8123',
			optional: true,
			hint: tr('The HTTP interface: 8123 by default, 8443 on ClickHouse Cloud.'),
		},
		{
			key: 'user',
			label: tr('User'),
			placeholder: 'default',
			optional: true,
			hint: tr('Leave empty to connect as the server default user.'),
		},
		{ key: 'password', label: tr('Password'), secret: true, optional: true },
		{
			key: 'database',
			label: tr('Database'),
			placeholder: 'analytics',
			hint: tr(
				'ClickHouse has no schema below the database, so one connection covers one database. Add a second connection for a second database.',
			),
		},
		{
			key: 'http_scheme',
			label: tr('Protocol'),
			placeholder: 'http',
			optional: true,
			hint: tr(
				'Leave empty to infer from the port: https on 443 and 8443, http otherwise. Set https explicitly for a TLS listener on any other port — unlike Trino, a password alone does not imply TLS here.',
			),
		},
	],
};

/**
 * Fields offered for every connector, appended after the type-specific ones.
 *
 * Kept separate rather than copied into all eight lists: they are enforced
 * centrally at catalog extraction (`auto_ontology/catalog/table_filter.py`), so
 * every connector honours them identically and none may drift.
 */
export const COMMON_CONNECTION_FIELDS: ConnectionField[] = [
	{
		key: 'table_allow_regex',
		label: tr('Table Allowlist (Regex)'),
		placeholder: tr('Leave Empty to Ingest Every Table'),
		optional: true,
		hint: tr(
			'Ingest only tables whose name matches. Unanchored and case-sensitive, so "fact_" matches "fact_sales"; anchor with ^ and $ for an exact name.',
		),
	},
	{
		key: 'table_deny_regex',
		label: tr('Table Denylist (Regex)'),
		placeholder: tr('Leave Empty to Exclude Nothing'),
		optional: true,
		hint: tr(
			'Skip tables whose name matches, even if the allowlist also matches them. Use this for relations the warehouse lists but cannot actually read, such as a broken Distributed table or a Kafka queue.',
		),
	},
];

/** Form fields for a connector: its own, plus the ones shared by all of them. */
export const connectionFieldsFor = (type: ConnectionType): ConnectionField[] => [
	...CONNECTION_FIELDS[type],
	...COMMON_CONNECTION_FIELDS,
];
