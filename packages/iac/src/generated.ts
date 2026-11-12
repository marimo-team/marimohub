export type SecretInput =
	| string
	| { $secret: { kind: 'reference'; backend: string; locator: string } }
	| { $secret: { kind: 'managed'; set: true } };
export interface paths {
	'/kinds/agent_context/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored agent_context config */
		get: operations['read_agent_context_config'];
		/** Input agent_context config */
		put: operations['write_agent_context_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/athena/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored athena config */
		get: operations['read_athena_config'];
		/** Input athena config */
		put: operations['write_athena_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/aws_codeartifact/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored aws_codeartifact config */
		get: operations['read_aws_codeartifact_config'];
		/** Input aws_codeartifact config */
		put: operations['write_aws_codeartifact_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/azure_artifacts/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored azure_artifacts config */
		get: operations['read_azure_artifacts_config'];
		/** Input azure_artifacts config */
		put: operations['write_azure_artifacts_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/azure_blob/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored azure_blob config */
		get: operations['read_azure_blob_config'];
		/** Input azure_blob config */
		put: operations['write_azure_blob_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/bigquery/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored bigquery config */
		get: operations['read_bigquery_config'];
		/** Input bigquery config */
		put: operations['write_bigquery_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/clickhouse/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored clickhouse config */
		get: operations['read_clickhouse_config'];
		/** Input clickhouse config */
		put: operations['write_clickhouse_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/custom_css/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored custom_css config */
		get: operations['read_custom_css_config'];
		/** Input custom_css config */
		put: operations['write_custom_css_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/custom_env/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored custom_env config */
		get: operations['read_custom_env_config'];
		/** Input custom_env config */
		put: operations['write_custom_env_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/databricks/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored databricks config */
		get: operations['read_databricks_config'];
		/** Input databricks config */
		put: operations['write_databricks_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/duckdb_http/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored duckdb_http config */
		get: operations['read_duckdb_http_config'];
		/** Input duckdb_http config */
		put: operations['write_duckdb_http_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/ducklake/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored ducklake config */
		get: operations['read_ducklake_config'];
		/** Input ducklake config */
		put: operations['write_ducklake_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/gcs/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored gcs config */
		get: operations['read_gcs_config'];
		/** Input gcs config */
		put: operations['write_gcs_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/gitlab_packages/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored gitlab_packages config */
		get: operations['read_gitlab_packages_config'];
		/** Input gitlab_packages config */
		put: operations['write_gitlab_packages_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/html_head/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored html_head config */
		get: operations['read_html_head_config'];
		/** Input html_head config */
		put: operations['write_html_head_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/huggingface/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored huggingface config */
		get: operations['read_huggingface_config'];
		/** Input huggingface config */
		put: operations['write_huggingface_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/iceberg_bigquery/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored iceberg_bigquery config */
		get: operations['read_iceberg_bigquery_config'];
		/** Input iceberg_bigquery config */
		put: operations['write_iceberg_bigquery_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/iceberg_dynamodb/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored iceberg_dynamodb config */
		get: operations['read_iceberg_dynamodb_config'];
		/** Input iceberg_dynamodb config */
		put: operations['write_iceberg_dynamodb_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/iceberg_glue/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored iceberg_glue config */
		get: operations['read_iceberg_glue_config'];
		/** Input iceberg_glue config */
		put: operations['write_iceberg_glue_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/iceberg_hive/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored iceberg_hive config */
		get: operations['read_iceberg_hive_config'];
		/** Input iceberg_hive config */
		put: operations['write_iceberg_hive_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/iceberg_rest/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored iceberg_rest config */
		get: operations['read_iceberg_rest_config'];
		/** Input iceberg_rest config */
		put: operations['write_iceberg_rest_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/iceberg_sql/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored iceberg_sql config */
		get: operations['read_iceberg_sql_config'];
		/** Input iceberg_sql config */
		put: operations['write_iceberg_sql_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/jfrog_artifactory/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored jfrog_artifactory config */
		get: operations['read_jfrog_artifactory_config'];
		/** Input jfrog_artifactory config */
		put: operations['write_jfrog_artifactory_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/marimo_studio/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored marimo_studio config */
		get: operations['read_marimo_studio_config'];
		/** Input marimo_studio config */
		put: operations['write_marimo_studio_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/mongodb/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored mongodb config */
		get: operations['read_mongodb_config'];
		/** Input mongodb config */
		put: operations['write_mongodb_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/motherduck/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored motherduck config */
		get: operations['read_motherduck_config'];
		/** Input motherduck config */
		put: operations['write_motherduck_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/mysql/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored mysql config */
		get: operations['read_mysql_config'];
		/** Input mysql config */
		put: operations['write_mysql_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/otlp_logs/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored otlp_logs config */
		get: operations['read_otlp_logs_config'];
		/** Input otlp_logs config */
		put: operations['write_otlp_logs_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/postgres/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored postgres config */
		get: operations['read_postgres_config'];
		/** Input postgres config */
		put: operations['write_postgres_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/pyspark/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored pyspark config */
		get: operations['read_pyspark_config'];
		/** Input pyspark config */
		put: operations['write_pyspark_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/python_package_index/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored python_package_index config */
		get: operations['read_python_package_index_config'];
		/** Input python_package_index config */
		put: operations['write_python_package_index_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/redshift/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored redshift config */
		get: operations['read_redshift_config'];
		/** Input redshift config */
		put: operations['write_redshift_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/s3/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored s3 config */
		get: operations['read_s3_config'];
		/** Input s3 config */
		put: operations['write_s3_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/snowflake/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored snowflake config */
		get: operations['read_snowflake_config'];
		/** Input snowflake config */
		put: operations['write_snowflake_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/sqlserver/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored sqlserver config */
		get: operations['read_sqlserver_config'];
		/** Input sqlserver config */
		put: operations['write_sqlserver_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/startup_script/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored startup_script config */
		get: operations['read_startup_script_config'];
		/** Input startup_script config */
		put: operations['write_startup_script_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/trino/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored trino config */
		get: operations['read_trino_config'];
		/** Input trino config */
		put: operations['write_trino_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
	'/kinds/wandb/config': {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		/** Stored wandb config */
		get: operations['read_wandb_config'];
		/** Input wandb config */
		put: operations['write_wandb_config'];
		post?: never;
		delete?: never;
		options?: never;
		head?: never;
		patch?: never;
		trace?: never;
	};
}
export type webhooks = Record<string, never>;
export interface components {
	schemas: {
		ManagedStoredSecret: {
			$secret: {
				/** @constant */
				kind: 'managed';
				envelope: {
					kek_id: string;
					/** @constant */
					alg: 'A256GCM';
					iv: string;
					ciphertext: string;
				};
			};
		};
		ReferenceStoredSecret: {
			$secret: {
				/** @constant */
				kind: 'reference';
				backend: string;
				locator: string;
			};
		};
		agent_context: {
			/** @description Shared Markdown instructions for coding agents. Maximum 32768 UTF-8 bytes. */
			instructions?: string;
			skills?: {
				name: string;
				/** @description Complete SKILL.md, including YAML frontmatter. Maximum 65536 UTF-8 bytes. */
				content: string;
			}[];
			/** @description OpenCode JSON configuration; reference custom environment variables for tokens. Maximum 16384 UTF-8 bytes. */
			opencode_json?: string;
			/** @description Claude Code user settings JSON; do not include secrets. Maximum 16384 UTF-8 bytes. */
			claude_settings_json?: string;
		};
		agent_context_stored: {
			/** @description Shared Markdown instructions for coding agents. Maximum 32768 UTF-8 bytes. */
			instructions?: string;
			skills?: {
				name: string;
				/** @description Complete SKILL.md, including YAML frontmatter. Maximum 65536 UTF-8 bytes. */
				content: string;
			}[];
			/** @description OpenCode JSON configuration; reference custom environment variables for tokens. Maximum 16384 UTF-8 bytes. */
			opencode_json?: string;
			/** @description Claude Code user settings JSON; do not include secrets. Maximum 16384 UTF-8 bytes. */
			claude_settings_json?: string;
		};
		athena: {
			region: string;
			/**
			 * Format: uri
			 * @description Bucket prefix Athena writes query results to
			 */
			s3_staging_dir: string;
			/** @default default */
			database?: string;
			/** @default primary */
			workgroup?: string;
			/** @default AwsDataCatalog */
			catalog?: string;
			/**
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			auth?:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'static';
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  };
		};
		athena_stored: {
			region: string;
			/**
			 * Format: uri
			 * @description Bucket prefix Athena writes query results to
			 */
			s3_staging_dir: string;
			/** @default default */
			database: string;
			/** @default primary */
			workgroup: string;
			/** @default AwsDataCatalog */
			catalog: string;
			/**
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			auth:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'static';
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  };
		};
		aws_codeartifact: {
			/** @description CodeArtifact domain name */
			domain: string;
			/** @description AWS account ID that owns the domain */
			domain_owner: string;
			/** @description CodeArtifact repository name */
			repository: string;
			/**
			 * @description AWS region of the domain, for example us-east-1
			 * @default us-east-1
			 */
			region?: string;
			/** @description How the hub gets AWS credentials to mint the CodeArtifact token: `ambient` uses the project's workload identity (WIF), `static` uses the AWS keys below. Neither reaches the sandbox. */
			auth:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'static';
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  };
			/**
			 * @description Replace public PyPI with this repository
			 * @default false
			 */
			default_index?: boolean;
		};
		aws_codeartifact_stored: {
			/** @description CodeArtifact domain name */
			domain: string;
			/** @description AWS account ID that owns the domain */
			domain_owner: string;
			/** @description CodeArtifact repository name */
			repository: string;
			/**
			 * @description AWS region of the domain, for example us-east-1
			 * @default us-east-1
			 */
			region: string;
			/** @description How the hub gets AWS credentials to mint the CodeArtifact token: `ambient` uses the project's workload identity (WIF), `static` uses the AWS keys below. Neither reaches the sandbox. */
			auth:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'static';
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  };
			/**
			 * @description Replace public PyPI with this repository
			 * @default false
			 */
			default_index: boolean;
		};
		azure_artifacts: {
			organization: string;
			/** @description Omit for an organization-scoped feed */
			project?: string;
			feed: string;
			auth: {
				/** @constant */
				method: 'token';
				/** @description Azure DevOps personal access token with Packaging read permission */
				token: SecretInput;
			};
			/**
			 * @description Replace public PyPI with this repository
			 * @default false
			 */
			default_index?: boolean;
		};
		azure_artifacts_stored: {
			organization: string;
			/** @description Omit for an organization-scoped feed */
			project?: string;
			feed: string;
			auth: {
				/** @constant */
				method: 'token';
				/** @description Azure DevOps personal access token with Packaging read permission */
				token: SecretInput;
			};
			/**
			 * @description Replace public PyPI with this repository
			 * @default false
			 */
			default_index: boolean;
		};
		azure_blob: {
			/**
			 * @description Allow managers to upload objects with integration credentials. Server ambient credentials cannot write.
			 * @default false
			 */
			allow_write?: boolean;
			account_name: string;
			/** @description Default container for notebook code */
			container?: string;
			/**
			 * @description Sovereign clouds use their own, e.g. core.chinacloudapi.cn
			 * @default core.windows.net
			 */
			endpoint_suffix?: string;
			auth:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'account_key';
						account_key: SecretInput;
				  }
				| {
						/** @constant */
						method: 'sas_token';
						sas_token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'connection_string';
						connection_string: SecretInput;
				  }
				| {
						/** @constant */
						method: 'service_principal';
						tenant_id: string;
						client_id: string;
						client_secret: SecretInput;
				  };
			/**
			 * @description Export shared vendor variables for automatic connections. Conflicting values prevent notebook startup.
			 * @default true
			 */
			ambient_env?: boolean;
		};
		azure_blob_stored: {
			/**
			 * @description Allow managers to upload objects with integration credentials. Server ambient credentials cannot write.
			 * @default false
			 */
			allow_write: boolean;
			account_name: string;
			/** @description Default container for notebook code */
			container?: string;
			/**
			 * @description Sovereign clouds use their own, e.g. core.chinacloudapi.cn
			 * @default core.windows.net
			 */
			endpoint_suffix: string;
			auth:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'account_key';
						account_key: SecretInput;
				  }
				| {
						/** @constant */
						method: 'sas_token';
						sas_token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'connection_string';
						connection_string: SecretInput;
				  }
				| {
						/** @constant */
						method: 'service_principal';
						tenant_id: string;
						client_id: string;
						client_secret: SecretInput;
				  };
			/**
			 * @description Export shared vendor variables for automatic connections. Conflicting values prevent notebook startup.
			 * @default true
			 */
			ambient_env: boolean;
		};
		bigquery: {
			/** @description Google Cloud project that owns the datasets */
			project_id: string;
			/** @description Default dataset for unqualified table names */
			dataset?: string;
			/** @description Dataset location, e.g. US or europe-west4 */
			location?: string;
			/**
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			auth?:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'service_account';
						credentials_json: SecretInput;
				  };
			/**
			 * @description Export shared vendor variables for automatic connections. Conflicting values prevent notebook startup.
			 * @default false
			 */
			ambient_env?: boolean;
		};
		bigquery_stored: {
			/** @description Google Cloud project that owns the datasets */
			project_id: string;
			/** @description Default dataset for unqualified table names */
			dataset?: string;
			/** @description Dataset location, e.g. US or europe-west4 */
			location?: string;
			/**
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			auth:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'service_account';
						credentials_json: SecretInput;
				  };
			/**
			 * @description Export shared vendor variables for automatic connections. Conflicting values prevent notebook startup.
			 * @default false
			 */
			ambient_env: boolean;
		};
		clickhouse: {
			/** @description Server hostname, e.g. abc123.us-east-1.aws.clickhouse.cloud */
			host: string;
			/**
			 * @description HTTP interface port
			 * @default 8443
			 */
			port?: number;
			/**
			 * @description Use HTTPS for the HTTP interface
			 * @default true
			 */
			secure?: boolean;
			/**
			 * @description Verify the server certificate (clickhouse-connect `verify`)
			 * @default true
			 */
			verify?: boolean;
			/** @default default */
			database?: string;
			/** @default default */
			username?: string;
			/** @description Omit for a user with no password */
			password?: SecretInput;
		};
		clickhouse_stored: {
			/** @description Server hostname, e.g. abc123.us-east-1.aws.clickhouse.cloud */
			host: string;
			/**
			 * @description HTTP interface port
			 * @default 8443
			 */
			port: number;
			/**
			 * @description Use HTTPS for the HTTP interface
			 * @default true
			 */
			secure: boolean;
			/**
			 * @description Verify the server certificate (clickhouse-connect `verify`)
			 * @default true
			 */
			verify: boolean;
			/** @default default */
			database: string;
			/** @default default */
			username: string;
			/** @description Omit for a user with no password */
			password?: SecretInput;
		};
		custom_css: {
			/** @description CSS stylesheet applied to marimo pages. Maximum 65536 UTF-8 bytes. */
			css: string;
		};
		custom_css_stored: {
			/** @description CSS stylesheet applied to marimo pages. Maximum 65536 UTF-8 bytes. */
			css: string;
		};
		custom_env: {
			/**
			 * @description Plain environment variables, visible to project managers
			 * @default {}
			 */
			vars?: {
				[key: string]: string;
			};
			/**
			 * @description Secret environment variables from encrypted values or an external manager
			 * @default []
			 */
			secrets?: {
				name: string;
				value: SecretInput;
			}[];
			/**
			 * @description JSON secret objects expanded into one environment variable per key
			 * @default []
			 */
			secret_bundles?: {
				/** @description Stable name used to retain this bundle across edits */
				name: string;
				/** @description A JSON object containing environment variable values */
				value: SecretInput;
				prefix?: string;
			}[];
		};
		custom_env_stored: {
			/**
			 * @description Plain environment variables, visible to project managers
			 * @default {}
			 */
			vars: {
				[key: string]: string;
			};
			/**
			 * @description Secret environment variables from encrypted values or an external manager
			 * @default []
			 */
			secrets: {
				name: string;
				value: SecretInput;
			}[];
			/**
			 * @description JSON secret objects expanded into one environment variable per key
			 * @default []
			 */
			secret_bundles: {
				/** @description Stable name used to retain this bundle across edits */
				name: string;
				/** @description A JSON object containing environment variable values */
				value: SecretInput;
				prefix?: string;
			}[];
		};
		databricks: {
			/** @description Workspace hostname, e.g. dbc-1234abcd-5678.cloud.databricks.com */
			host: string;
			/** @description SQL warehouse or cluster HTTP path */
			http_path: string;
			auth:
				| {
						/** @constant */
						method: 'personal_access_token';
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'oauth_m2m';
						client_id: string;
						client_secret: SecretInput;
				  };
			/** @description Unity Catalog name for unqualified tables */
			catalog?: string;
			/** @description Session default schema */
			schema?: string;
		};
		databricks_stored: {
			/** @description Workspace hostname, e.g. dbc-1234abcd-5678.cloud.databricks.com */
			host: string;
			/** @description SQL warehouse or cluster HTTP path */
			http_path: string;
			auth:
				| {
						/** @constant */
						method: 'personal_access_token';
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'oauth_m2m';
						client_id: string;
						client_secret: SecretInput;
				  };
			/** @description Unity Catalog name for unqualified tables */
			catalog?: string;
			/** @description Session default schema */
			schema?: string;
		};
		duckdb_http: {
			/** @description Exact HTTPS URL of one immutable DuckDB database file */
			url: string;
			auth:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'bearer_token';
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'basic';
						username: string;
						password: SecretInput;
				  };
			/**
			 * @description Allow a URL path that does not end in .duckdb
			 * @default false
			 */
			allow_non_duckdb_suffix?: boolean;
		};
		duckdb_http_stored: {
			/** @description Exact HTTPS URL of one immutable DuckDB database file */
			url: string;
			auth:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'bearer_token';
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'basic';
						username: string;
						password: SecretInput;
				  };
			/**
			 * @description Allow a URL path that does not end in .duckdb
			 * @default false
			 */
			allow_non_duckdb_suffix: boolean;
		};
		ducklake: {
			metadata: {
				/**
				 * @description Metadata catalog format. Only DuckDB catalog files are supported.
				 * @constant
				 */
				type: 'duckdb';
				/** @description Exact HTTPS URL of one immutable DuckLake metadata file */
				url: string;
				/** @description How the hub authenticates to the metadata URL. Never forwarded to S3 requests. */
				auth:
					| {
							/** @constant */
							method: 'none';
					  }
					| {
							/** @constant */
							method: 'bearer_token';
							token: SecretInput;
					  }
					| {
							/** @constant */
							method: 'basic';
							username: string;
							password: SecretInput;
					  };
				/**
				 * @description Accept a metadata URL that does not end in `.ducklake` or `.duckdb`.
				 * @default false
				 */
				allow_non_database_suffix?: boolean;
			};
			storage: {
				/**
				 * @description Data-file storage scheme. Only S3-compatible storage is supported.
				 * @constant
				 */
				scheme: 's3';
				/**
				 * Format: uri
				 * @description Origin-only HTTPS S3 endpoint, e.g. `https://s3.us-east-1.amazonaws.com`.
				 */
				endpoint: string;
				/** @description AWS region used to sign S3 requests, e.g. `us-east-1`. */
				region: string;
				/**
				 * @description Address buckets as `{bucket}.{endpoint}` (virtual-hosted style) instead of `{endpoint}/{bucket}` (path style).
				 * @default true
				 */
				force_virtual_addressing?: boolean;
				credentials: {
					/**
					 * @description Credential source. Only static keys are supported.
					 * @constant
					 */
					method: 'static';
					/** @description AWS access key ID. Held by the hub broker; never sent to the notebook worker. */
					access_key_id: SecretInput;
					/** @description AWS secret access key. Held by the hub broker; never sent to the notebook worker. */
					secret_access_key: SecretInput;
					/** @description AWS session token for temporary credentials. */
					session_token?: SecretInput;
				};
				/** @description Bucket prefixes the broker may read data files from. Requests outside these locations are rejected. */
				broker_read_locations: {
					bucket: string;
					prefix: string;
				}[];
			};
			/** @default {} */
			snapshot?: {
				/** @description Read this DuckLake snapshot version instead of the latest snapshot. */
				version?: number;
				/**
				 * Format: date-time
				 * @description Read the snapshot current at this RFC 3339 timestamp instead of the latest.
				 */
				timestamp?: string;
			};
		};
		ducklake_stored: {
			metadata: {
				/**
				 * @description Metadata catalog format. Only DuckDB catalog files are supported.
				 * @constant
				 */
				type: 'duckdb';
				/** @description Exact HTTPS URL of one immutable DuckLake metadata file */
				url: string;
				/** @description How the hub authenticates to the metadata URL. Never forwarded to S3 requests. */
				auth:
					| {
							/** @constant */
							method: 'none';
					  }
					| {
							/** @constant */
							method: 'bearer_token';
							token: SecretInput;
					  }
					| {
							/** @constant */
							method: 'basic';
							username: string;
							password: SecretInput;
					  };
				/**
				 * @description Accept a metadata URL that does not end in `.ducklake` or `.duckdb`.
				 * @default false
				 */
				allow_non_database_suffix: boolean;
			};
			storage: {
				/**
				 * @description Data-file storage scheme. Only S3-compatible storage is supported.
				 * @constant
				 */
				scheme: 's3';
				/**
				 * Format: uri
				 * @description Origin-only HTTPS S3 endpoint, e.g. `https://s3.us-east-1.amazonaws.com`.
				 */
				endpoint: string;
				/** @description AWS region used to sign S3 requests, e.g. `us-east-1`. */
				region: string;
				/**
				 * @description Address buckets as `{bucket}.{endpoint}` (virtual-hosted style) instead of `{endpoint}/{bucket}` (path style).
				 * @default true
				 */
				force_virtual_addressing: boolean;
				credentials: {
					/**
					 * @description Credential source. Only static keys are supported.
					 * @constant
					 */
					method: 'static';
					/** @description AWS access key ID. Held by the hub broker; never sent to the notebook worker. */
					access_key_id: SecretInput;
					/** @description AWS secret access key. Held by the hub broker; never sent to the notebook worker. */
					secret_access_key: SecretInput;
					/** @description AWS session token for temporary credentials. */
					session_token?: SecretInput;
				};
				/** @description Bucket prefixes the broker may read data files from. Requests outside these locations are rejected. */
				broker_read_locations: {
					bucket: string;
					prefix: string;
				}[];
			};
			/** @default {} */
			snapshot: {
				/** @description Read this DuckLake snapshot version instead of the latest snapshot. */
				version?: number;
				/**
				 * Format: date-time
				 * @description Read the snapshot current at this RFC 3339 timestamp instead of the latest.
				 */
				timestamp?: string;
			};
		};
		gcs: {
			/**
			 * @description Allow managers to upload objects with integration credentials. Server ambient credentials cannot write.
			 * @default false
			 */
			allow_write?: boolean;
			/** @description Default bucket for notebook code; the credentials are not restricted to it */
			bucket?: string;
			/** @description Project billed for the requests */
			project_id?: string;
			/**
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			auth?:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'service_account';
						credentials_json: SecretInput;
				  };
			/**
			 * @description Export shared vendor variables for automatic connections. Conflicting values prevent notebook startup.
			 * @default true
			 */
			ambient_env?: boolean;
		};
		gcs_stored: {
			/**
			 * @description Allow managers to upload objects with integration credentials. Server ambient credentials cannot write.
			 * @default false
			 */
			allow_write: boolean;
			/** @description Default bucket for notebook code; the credentials are not restricted to it */
			bucket?: string;
			/** @description Project billed for the requests */
			project_id?: string;
			/**
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			auth:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'service_account';
						credentials_json: SecretInput;
				  };
			/**
			 * @description Export shared vendor variables for automatic connections. Conflicting values prevent notebook startup.
			 * @default true
			 */
			ambient_env: boolean;
		};
		gitlab_packages: {
			/**
			 * Format: uri
			 * @description GitLab instance base URL
			 * @default https://gitlab.com
			 */
			url?: string & (unknown & unknown & unknown);
			/**
			 * @default project
			 * @enum {string}
			 */
			scope?: 'project' | 'group';
			/** @description Numeric GitLab project or group ID */
			scope_id: string;
			auth: {
				/** @constant */
				method: 'token';
				/** @description Deploy token username or personal access token name */
				username: string;
				/** @description Deploy token with read_package_registry, or personal access token with api scope */
				token: SecretInput;
			};
			/**
			 * @description Replace public PyPI with this repository
			 * @default false
			 */
			default_index?: boolean;
		};
		gitlab_packages_stored: {
			/**
			 * Format: uri
			 * @description GitLab instance base URL
			 * @default https://gitlab.com
			 */
			url: string & (unknown & unknown & unknown);
			/**
			 * @default project
			 * @enum {string}
			 */
			scope: 'project' | 'group';
			/** @description Numeric GitLab project or group ID */
			scope_id: string;
			auth: {
				/** @constant */
				method: 'token';
				/** @description Deploy token username or personal access token name */
				username: string;
				/** @description Deploy token with read_package_registry, or personal access token with api scope */
				token: SecretInput;
			};
			/**
			 * @description Replace public PyPI with this repository
			 * @default false
			 */
			default_index: boolean;
		};
		html_head: {
			/** @description HTML head fragment, including any browser scripts; visible to app viewers. Maximum 65536 UTF-8 bytes. */
			html: string;
		};
		html_head_stored: {
			/** @description HTML head fragment, including any browser scripts; visible to app viewers. Maximum 65536 UTF-8 bytes. */
			html: string;
		};
		huggingface: {
			/** @description Access token from huggingface.co/settings/tokens */
			token: SecretInput;
			/**
			 * Format: uri
			 * @description Set this for an Enterprise Hub deployment
			 * @default https://huggingface.co
			 */
			endpoint?: string;
			/**
			 * @description Faster large-file downloads; requires the hf_transfer package
			 * @default false
			 */
			enable_hf_transfer?: boolean;
		};
		huggingface_stored: {
			/** @description Access token from huggingface.co/settings/tokens */
			token: SecretInput;
			/**
			 * Format: uri
			 * @description Set this for an Enterprise Hub deployment
			 * @default https://huggingface.co
			 */
			endpoint: string;
			/**
			 * @description Faster large-file downloads; requires the hf_transfer package
			 * @default false
			 */
			enable_hf_transfer: boolean;
		};
		iceberg_bigquery: {
			project_id: string;
			location?: string;
			/** @description Default Iceberg table storage location */
			warehouse: string;
			/**
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			credentials?:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'service_account_json';
						credentials_json: SecretInput;
				  };
			storage?: components['schemas']['IcebergStorage'];
			runtime?: components['schemas']['IcebergRuntime'];
			extra_properties?: components['schemas']['IcebergExtraProperties'];
		};
		iceberg_bigquery_stored: {
			project_id: string;
			location?: string;
			/** @description Default Iceberg table storage location */
			warehouse: string;
			/**
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			credentials:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'service_account_json';
						credentials_json: SecretInput;
				  };
			storage: components['schemas']['IcebergStorageStored'];
			runtime: components['schemas']['IcebergRuntimeStored'];
			extra_properties: components['schemas']['IcebergExtraPropertiesStored'];
		};
		iceberg_dynamodb: {
			/** @default iceberg */
			table_name?: string;
			/** @description Default Iceberg table storage location */
			warehouse?: string;
			region?: string;
			/**
			 * @description DynamoDB Catalog credentials only. When explicit, these override unified credentials for DynamoDB calls. The catalog region uses the region field; PyIceberg exposes role assumption through unified credentials.
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			credentials?:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'static';
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'profile';
						profile_name: string;
				  };
			/**
			 * @description Client credentials shared by DynamoDB and S3 FileIO. DynamoDB-specific and storage-specific credentials override these.
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			unified_credentials?:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'static';
						region?: string;
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'profile';
						region?: string;
						profile_name: string;
				  }
				| {
						/** @constant */
						method: 'role';
						region?: string;
						role_arn: string;
						role_session_name?: string;
				  };
			storage?: components['schemas']['IcebergStorage'];
			runtime?: components['schemas']['IcebergRuntime'];
			extra_properties?: components['schemas']['IcebergExtraProperties'];
		};
		iceberg_dynamodb_stored: {
			/** @default iceberg */
			table_name: string;
			/** @description Default Iceberg table storage location */
			warehouse?: string;
			region?: string;
			/**
			 * @description DynamoDB Catalog credentials only. When explicit, these override unified credentials for DynamoDB calls. The catalog region uses the region field; PyIceberg exposes role assumption through unified credentials.
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			credentials:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'static';
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'profile';
						profile_name: string;
				  };
			/**
			 * @description Client credentials shared by DynamoDB and S3 FileIO. DynamoDB-specific and storage-specific credentials override these.
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			unified_credentials:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'static';
						region?: string;
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'profile';
						region?: string;
						profile_name: string;
				  }
				| {
						/** @constant */
						method: 'role';
						region?: string;
						role_arn: string;
						role_session_name?: string;
				  };
			storage: components['schemas']['IcebergStorageStored'];
			runtime: components['schemas']['IcebergRuntimeStored'];
			extra_properties: components['schemas']['IcebergExtraPropertiesStored'];
		};
		iceberg_glue: {
			/** @description Default Iceberg table storage location */
			warehouse?: string;
			catalog_id?: string;
			region?: string;
			/** Format: uri */
			endpoint?: string;
			/**
			 * @description Glue Catalog credentials only. When explicit, these override unified credentials for Glue calls. The catalog region uses the region field; PyIceberg exposes role assumption through unified credentials.
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			credentials?:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'static';
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'profile';
						profile_name: string;
				  };
			/**
			 * @description Client credentials shared by Glue and S3 FileIO. Glue-specific and storage-specific credentials override these.
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			unified_credentials?:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'static';
						region?: string;
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'profile';
						region?: string;
						profile_name: string;
				  }
				| {
						/** @constant */
						method: 'role';
						region?: string;
						role_arn: string;
						role_session_name?: string;
				  };
			/** @default true */
			skip_archive?: boolean;
			/** @default 10 */
			max_retries?: number;
			/**
			 * @default standard
			 * @enum {string}
			 */
			retry_mode?: 'legacy' | 'standard' | 'adaptive';
			storage?: components['schemas']['IcebergStorage'];
			runtime?: components['schemas']['IcebergRuntime'];
			extra_properties?: components['schemas']['IcebergExtraProperties'];
		};
		iceberg_glue_stored: {
			/** @description Default Iceberg table storage location */
			warehouse?: string;
			catalog_id?: string;
			region?: string;
			/** Format: uri */
			endpoint?: string;
			/**
			 * @description Glue Catalog credentials only. When explicit, these override unified credentials for Glue calls. The catalog region uses the region field; PyIceberg exposes role assumption through unified credentials.
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			credentials:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'static';
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'profile';
						profile_name: string;
				  };
			/**
			 * @description Client credentials shared by Glue and S3 FileIO. Glue-specific and storage-specific credentials override these.
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			unified_credentials:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'static';
						region?: string;
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'profile';
						region?: string;
						profile_name: string;
				  }
				| {
						/** @constant */
						method: 'role';
						region?: string;
						role_arn: string;
						role_session_name?: string;
				  };
			/** @default true */
			skip_archive: boolean;
			/** @default 10 */
			max_retries: number;
			/**
			 * @default standard
			 * @enum {string}
			 */
			retry_mode: 'legacy' | 'standard' | 'adaptive';
			storage: components['schemas']['IcebergStorageStored'];
			runtime: components['schemas']['IcebergRuntimeStored'];
			extra_properties: components['schemas']['IcebergExtraPropertiesStored'];
		};
		iceberg_hive: {
			uri: string;
			/** @description Default Iceberg table storage location */
			warehouse?: string;
			/** @default false */
			hive2_compatible?: boolean;
			/**
			 * @default {
			 *       "enabled": false,
			 *       "service_name": "hive"
			 *     }
			 */
			kerberos?: {
				/** @default false */
				enabled?: boolean;
				/** @default hive */
				service_name?: string;
			};
			/** @description Hadoop user/group identity */
			ugi?: SecretInput;
			storage?: components['schemas']['IcebergStorage'];
			runtime?: components['schemas']['IcebergRuntime'];
			extra_properties?: components['schemas']['IcebergExtraProperties'];
		};
		iceberg_hive_stored: {
			uri: string;
			/** @description Default Iceberg table storage location */
			warehouse?: string;
			/** @default false */
			hive2_compatible: boolean;
			/**
			 * @default {
			 *       "enabled": false,
			 *       "service_name": "hive"
			 *     }
			 */
			kerberos: {
				/** @default false */
				enabled: boolean;
				/** @default hive */
				service_name: string;
			};
			/** @description Hadoop user/group identity */
			ugi?: SecretInput;
			storage: components['schemas']['IcebergStorageStored'];
			runtime: components['schemas']['IcebergRuntimeStored'];
			extra_properties: components['schemas']['IcebergExtraPropertiesStored'];
		};
		iceberg_rest: {
			/**
			 * Format: uri
			 * @description REST catalog base URI, e.g. https://catalog.internal/api/catalog
			 */
			uri: string;
			/** @description Warehouse name/path if the server hosts several */
			warehouse?: string;
			/**
			 * @description Allow http:// endpoints to carry credentials — local development only
			 * @default false
			 */
			allow_insecure_transport?: boolean;
			auth:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'bearer_token';
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'basic';
						username: string;
						password: SecretInput;
				  }
				| {
						/** @constant */
						method: 'oauth2_client_credentials';
						/** Format: uri */
						token_endpoint: string;
						client_id: string;
						client_secret: SecretInput;
						/** @default catalog */
						scope?: string;
						/** @default 60 */
						refresh_margin_seconds?: number;
						expires_in_seconds?: number;
				  }
				| {
						/** @constant */
						method: 'sigv4';
						region: string;
						/** @default execute-api */
						signing_name?: string;
				  }
				| {
						/** @constant */
						method: 'google';
						/** @description Comma-separated OAuth scopes; uses Google ADC */
						scopes?: string;
						/** @description Google service-account JSON */
						credentials_json?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'entra';
						/** @description Comma-separated OAuth scopes; uses Azure credentials */
						scopes?: string;
						managed_identity_client_id?: string;
				  };
			storage?: components['schemas']['IcebergRestStorage'];
			runtime?: components['schemas']['IcebergRuntime'];
			/**
			 * @description Catalog delegation mode. Guarded Run SQL supports bounded S3 vended credentials.
			 * @default vended_credentials
			 * @enum {string}
			 */
			access_delegation?: 'none' | 'vended_credentials' | 'remote_signing' | 'both';
			/** @default {} */
			tls?: {
				ca_bundle?: string;
				client_certificate?: string;
				client_key?: SecretInput;
			};
			/**
			 * @default {
			 *       "snapshot_loading_mode": "all",
			 *       "metrics_reporting_enabled": true,
			 *       "view_endpoints_supported": false,
			 *       "scan_planning_mode": "client",
			 *       "namespace_separator": "%1F",
			 *       "table_cache_expire_after_write_ms": 300000,
			 *       "table_cache_max_entries": 100
			 *     }
			 */
			rest?: {
				/**
				 * @default all
				 * @enum {string}
				 */
				snapshot_loading_mode?: 'all' | 'refs';
				/** @default true */
				metrics_reporting_enabled?: boolean;
				page_size?: number;
				/** @default false */
				view_endpoints_supported?: boolean;
				/**
				 * @default client
				 * @enum {string}
				 */
				scan_planning_mode?: 'client' | 'server';
				/** @default %1F */
				namespace_separator?: string;
				/** @default 300000 */
				table_cache_expire_after_write_ms?: number;
				/** @default 100 */
				table_cache_max_entries?: number;
			};
			/**
			 * @description Additional HTTP headers sent to the REST catalog
			 * @default {}
			 */
			headers?: {
				[key: string]: string;
			};
			extra_properties?: components['schemas']['IcebergExtraProperties'];
		};
		iceberg_rest_stored: {
			/**
			 * Format: uri
			 * @description REST catalog base URI, e.g. https://catalog.internal/api/catalog
			 */
			uri: string;
			/** @description Warehouse name/path if the server hosts several */
			warehouse?: string;
			/**
			 * @description Allow http:// endpoints to carry credentials — local development only
			 * @default false
			 */
			allow_insecure_transport: boolean;
			auth:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'bearer_token';
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'basic';
						username: string;
						password: SecretInput;
				  }
				| {
						/** @constant */
						method: 'oauth2_client_credentials';
						/** Format: uri */
						token_endpoint: string;
						client_id: string;
						client_secret: SecretInput;
						/** @default catalog */
						scope: string;
						/** @default 60 */
						refresh_margin_seconds: number;
						expires_in_seconds?: number;
				  }
				| {
						/** @constant */
						method: 'sigv4';
						region: string;
						/** @default execute-api */
						signing_name: string;
				  }
				| {
						/** @constant */
						method: 'google';
						/** @description Comma-separated OAuth scopes; uses Google ADC */
						scopes?: string;
						/** @description Google service-account JSON */
						credentials_json?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'entra';
						/** @description Comma-separated OAuth scopes; uses Azure credentials */
						scopes?: string;
						managed_identity_client_id?: string;
				  };
			storage: components['schemas']['IcebergRestStorageStored'];
			runtime: components['schemas']['IcebergRuntimeStored'];
			/**
			 * @description Catalog delegation mode. Guarded Run SQL supports bounded S3 vended credentials.
			 * @default vended_credentials
			 * @enum {string}
			 */
			access_delegation: 'none' | 'vended_credentials' | 'remote_signing' | 'both';
			/** @default {} */
			tls: {
				ca_bundle?: string;
				client_certificate?: string;
				client_key?: SecretInput;
			};
			/**
			 * @default {
			 *       "snapshot_loading_mode": "all",
			 *       "metrics_reporting_enabled": true,
			 *       "view_endpoints_supported": false,
			 *       "scan_planning_mode": "client",
			 *       "namespace_separator": "%1F",
			 *       "table_cache_expire_after_write_ms": 300000,
			 *       "table_cache_max_entries": 100
			 *     }
			 */
			rest: {
				/**
				 * @default all
				 * @enum {string}
				 */
				snapshot_loading_mode: 'all' | 'refs';
				/** @default true */
				metrics_reporting_enabled: boolean;
				page_size?: number;
				/** @default false */
				view_endpoints_supported: boolean;
				/**
				 * @default client
				 * @enum {string}
				 */
				scan_planning_mode: 'client' | 'server';
				/** @default %1F */
				namespace_separator: string;
				/** @default 300000 */
				table_cache_expire_after_write_ms: number;
				/** @default 100 */
				table_cache_max_entries: number;
			};
			/**
			 * @description Additional HTTP headers sent to the REST catalog
			 * @default {}
			 */
			headers: {
				[key: string]: string;
			};
			extra_properties: components['schemas']['IcebergExtraPropertiesStored'];
		};
		iceberg_sql: {
			/** @description SQLAlchemy URI for PostgreSQL or SQLite */
			uri: SecretInput;
			/** @description Default Iceberg table storage location */
			warehouse?: string;
			/** @default true */
			init_catalog_tables?: boolean;
			/** @default false */
			echo?: boolean;
			/** @default false */
			pool_pre_ping?: boolean;
			storage?: components['schemas']['IcebergStorage'];
			runtime?: components['schemas']['IcebergRuntime'];
			extra_properties?: components['schemas']['IcebergExtraProperties'];
		};
		iceberg_sql_stored: {
			/** @description SQLAlchemy URI for PostgreSQL or SQLite */
			uri: SecretInput;
			/** @description Default Iceberg table storage location */
			warehouse?: string;
			/** @default true */
			init_catalog_tables: boolean;
			/** @default false */
			echo: boolean;
			/** @default false */
			pool_pre_ping: boolean;
			storage: components['schemas']['IcebergStorageStored'];
			runtime: components['schemas']['IcebergRuntimeStored'];
			extra_properties: components['schemas']['IcebergExtraPropertiesStored'];
		};
		jfrog_artifactory: {
			/**
			 * Format: uri
			 * @description Artifactory base URL, for example https://company.jfrog.io/artifactory
			 */
			url: string & (unknown & unknown & unknown);
			/** @description PyPI repository key */
			repository: string;
			auth:
				| {
						/** @constant */
						method: 'token';
						/** @description Artifactory access token (sent with an empty username) */
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'basic';
						username: string;
						/** @description Password or access token */
						password: SecretInput;
				  };
			/**
			 * @description Replace public PyPI with this repository
			 * @default false
			 */
			default_index?: boolean;
		};
		jfrog_artifactory_stored: {
			/**
			 * Format: uri
			 * @description Artifactory base URL, for example https://company.jfrog.io/artifactory
			 */
			url: string & (unknown & unknown & unknown);
			/** @description PyPI repository key */
			repository: string;
			auth:
				| {
						/** @constant */
						method: 'token';
						/** @description Artifactory access token (sent with an empty username) */
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'basic';
						username: string;
						/** @description Password or access token */
						password: SecretInput;
				  };
			/**
			 * @description Replace public PyPI with this repository
			 * @default false
			 */
			default_index: boolean;
		};
		marimo_studio: {
			/**
			 * @description Exact Studio version. It must support the sandbox image’s marimo version.
			 * @default 0.4.1
			 */
			version?: string;
			/**
			 * @description Include Deno for React, Svelte, Reveal.js, and Notebook Kit views.
			 * @default true
			 */
			deno?: boolean;
			/**
			 * @description Include Typst for report views.
			 * @default false
			 */
			typst?: boolean;
		};
		marimo_studio_stored: {
			/**
			 * @description Exact Studio version. It must support the sandbox image’s marimo version.
			 * @default 0.4.1
			 */
			version: string;
			/**
			 * @description Include Deno for React, Svelte, Reveal.js, and Notebook Kit views.
			 * @default true
			 */
			deno: boolean;
			/**
			 * @description Include Typst for report views.
			 * @default false
			 */
			typst: boolean;
		};
		mongodb: {
			/**
			 * @default mongodb+srv
			 * @enum {string}
			 */
			scheme?: 'mongodb+srv' | 'mongodb';
			/** @description Cluster hostname, e.g. cluster0.abcde.mongodb.net */
			host: string;
			/**
			 * @description Ignored for mongodb+srv
			 * @default 27017
			 */
			port?: number;
			/** @description Default database for `client.get_database()` */
			database?: string;
			/**
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			auth?:
				| {
						/** @constant */
						method: 'password';
						username: string;
						password: SecretInput;
						/** @default admin */
						auth_source?: string;
				  }
				| {
						/** @constant */
						method: 'none';
				  };
			/**
			 * @default {
			 *       "mode": "enabled"
			 *     }
			 */
			tls?:
				| {
						/** @constant */
						mode: 'enabled';
						/** @description PEM CA bundle to trust, written into the session */
						ca_bundle?: string;
						/** @description Absolute path to a CA bundle the runtime already ships (default /etc/ssl/certs/ca-certificates.crt) */
						ca_path?: string;
				  }
				| {
						/** @constant */
						mode: 'disabled';
				  };
		};
		mongodb_stored: {
			/**
			 * @default mongodb+srv
			 * @enum {string}
			 */
			scheme: 'mongodb+srv' | 'mongodb';
			/** @description Cluster hostname, e.g. cluster0.abcde.mongodb.net */
			host: string;
			/**
			 * @description Ignored for mongodb+srv
			 * @default 27017
			 */
			port: number;
			/** @description Default database for `client.get_database()` */
			database?: string;
			/**
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			auth:
				| {
						/** @constant */
						method: 'password';
						username: string;
						password: SecretInput;
						/** @default admin */
						auth_source: string;
				  }
				| {
						/** @constant */
						method: 'none';
				  };
			/**
			 * @default {
			 *       "mode": "enabled"
			 *     }
			 */
			tls:
				| {
						/** @constant */
						mode: 'enabled';
						/** @description PEM CA bundle to trust, written into the session */
						ca_bundle?: string;
						/** @description Absolute path to a CA bundle the runtime already ships (default /etc/ssl/certs/ca-certificates.crt) */
						ca_path?: string;
				  }
				| {
						/** @constant */
						mode: 'disabled';
				  };
		};
		motherduck: {
			/** @description MotherDuck service token */
			token: SecretInput;
			/** @description Database to attach; omit to attach every database in the account */
			database?: string;
			/**
			 * @description Block local file and extension access from the MotherDuck session
			 * @default false
			 */
			saas_mode?: boolean;
		};
		motherduck_stored: {
			/** @description MotherDuck service token */
			token: SecretInput;
			/** @description Database to attach; omit to attach every database in the account */
			database?: string;
			/**
			 * @description Block local file and extension access from the MotherDuck session
			 * @default false
			 */
			saas_mode: boolean;
		};
		mysql: {
			/** @description Server hostname, e.g. mysql.internal */
			host: string;
			/** @default 3306 */
			port?: number;
			database: string;
			username: string;
			/** @description Password for the database user */
			password: SecretInput;
			/**
			 * @description `verify_identity` checks the CA chain and the hostname; `disabled` is plaintext
			 * @default {
			 *       "mode": "verify_identity"
			 *     }
			 */
			ssl?:
				| {
						/** @constant */
						mode: 'verify_identity';
						/** @description PEM CA bundle to trust, written into the session */
						ca_bundle?: string;
						/** @description Absolute path to a CA bundle the runtime already ships (default /etc/ssl/certs/ca-certificates.crt) */
						ca_path?: string;
				  }
				| {
						/** @constant */
						mode: 'disabled';
				  };
			/**
			 * @description Automatically offer this connection in marimo's data-source discovery by exporting MYSQL_HOST, MYSQL_TCP_PORT, MYSQL_DATABASE, MYSQL_USER, and MYSQL_PASSWORD. If multiple integrations request the same variables, one is discovered and every connection remains available through its notebook snippet.
			 * @default true
			 */
			ambient_env?: boolean;
		};
		mysql_stored: {
			/** @description Server hostname, e.g. mysql.internal */
			host: string;
			/** @default 3306 */
			port: number;
			database: string;
			username: string;
			/** @description Password for the database user */
			password: SecretInput;
			/**
			 * @description `verify_identity` checks the CA chain and the hostname; `disabled` is plaintext
			 * @default {
			 *       "mode": "verify_identity"
			 *     }
			 */
			ssl:
				| {
						/** @constant */
						mode: 'verify_identity';
						/** @description PEM CA bundle to trust, written into the session */
						ca_bundle?: string;
						/** @description Absolute path to a CA bundle the runtime already ships (default /etc/ssl/certs/ca-certificates.crt) */
						ca_path?: string;
				  }
				| {
						/** @constant */
						mode: 'disabled';
				  };
			/**
			 * @description Automatically offer this connection in marimo's data-source discovery by exporting MYSQL_HOST, MYSQL_TCP_PORT, MYSQL_DATABASE, MYSQL_USER, and MYSQL_PASSWORD. If multiple integrations request the same variables, one is discovered and every connection remains available through its notebook snippet.
			 * @default true
			 */
			ambient_env: boolean;
		};
		otlp_logs: {
			/**
			 * Format: uri
			 * @description Full OTLP/HTTP JSON logs URL, including /v1/logs
			 */
			url: string;
			/**
			 * @description How export requests authenticate
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			auth?:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'bearer';
						/** @description Token sent as `Authorization: Bearer <token>` */
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'basic';
						/** @description Basic-auth username */
						username: string;
						/** @description Basic-auth password or token */
						password: SecretInput;
				  }
				| {
						/** @constant */
						method: 'headers';
						/** @description HTTP headers sent with every export request, such as an API key or tenant ID */
						headers: {
							/** @description HTTP header name */
							name: string;
							/** @description Header value, stored as a secret */
							value: SecretInput;
						}[];
				  };
			/**
			 * @description Lowest Python log level to export
			 * @default INFO
			 * @enum {string}
			 */
			level?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
			/** @description Export only these logger namespaces, up to 32 unique names. Leave empty to export all eligible loggers. */
			logger_names?: {
				/** @description Logger name, including its dotted descendants. Up to 256 characters, with no whitespace or empty dot-separated parts. */
				name: string;
			}[];
			/**
			 * @description OpenTelemetry `service.name` resource attribute
			 * @default marimohub-notebook
			 */
			service_name?: string;
		};
		otlp_logs_stored: {
			/**
			 * Format: uri
			 * @description Full OTLP/HTTP JSON logs URL, including /v1/logs
			 */
			url: string;
			/**
			 * @description How export requests authenticate
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			auth:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'bearer';
						/** @description Token sent as `Authorization: Bearer <token>` */
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'basic';
						/** @description Basic-auth username */
						username: string;
						/** @description Basic-auth password or token */
						password: SecretInput;
				  }
				| {
						/** @constant */
						method: 'headers';
						/** @description HTTP headers sent with every export request, such as an API key or tenant ID */
						headers: {
							/** @description HTTP header name */
							name: string;
							/** @description Header value, stored as a secret */
							value: SecretInput;
						}[];
				  };
			/**
			 * @description Lowest Python log level to export
			 * @default INFO
			 * @enum {string}
			 */
			level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
			/** @description Export only these logger namespaces, up to 32 unique names. Leave empty to export all eligible loggers. */
			logger_names?: {
				/** @description Logger name, including its dotted descendants. Up to 256 characters, with no whitespace or empty dot-separated parts. */
				name: string;
			}[];
			/**
			 * @description OpenTelemetry `service.name` resource attribute
			 * @default marimohub-notebook
			 */
			service_name: string;
		};
		postgres: {
			/** @description Server hostname, e.g. db.internal */
			host: string;
			/** @default 5432 */
			port?: number;
			database: string;
			username: string;
			/** @description Password for the database user */
			password: SecretInput;
			/**
			 * @description libpq sslmode; `verify-full` checks the CA chain and the hostname
			 * @default {
			 *       "mode": "verify-full"
			 *     }
			 */
			ssl?:
				| {
						/** @constant */
						mode: 'disable';
				  }
				| {
						/** @constant */
						mode: 'prefer';
				  }
				| {
						/** @constant */
						mode: 'require';
				  }
				| {
						/** @constant */
						mode: 'verify-ca';
						/** @description PEM CA bundle to trust, written into the session */
						ca_bundle?: string;
						/** @description Absolute path to a CA bundle the runtime already ships (default /etc/ssl/certs/ca-certificates.crt) */
						ca_path?: string;
				  }
				| {
						/** @constant */
						mode: 'verify-full';
						/** @description PEM CA bundle to trust, written into the session */
						ca_bundle?: string;
						/** @description Absolute path to a CA bundle the runtime already ships (default /etc/ssl/certs/ca-certificates.crt) */
						ca_path?: string;
				  };
			/**
			 * @description Automatically offer this connection in marimo's data-source discovery by exporting PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, and PGSSLMODE. If multiple integrations request the same variables, one is discovered and every connection remains available through its notebook snippet.
			 * @default true
			 */
			ambient_env?: boolean;
		};
		postgres_stored: {
			/** @description Server hostname, e.g. db.internal */
			host: string;
			/** @default 5432 */
			port: number;
			database: string;
			username: string;
			/** @description Password for the database user */
			password: SecretInput;
			/**
			 * @description libpq sslmode; `verify-full` checks the CA chain and the hostname
			 * @default {
			 *       "mode": "verify-full"
			 *     }
			 */
			ssl:
				| {
						/** @constant */
						mode: 'disable';
				  }
				| {
						/** @constant */
						mode: 'prefer';
				  }
				| {
						/** @constant */
						mode: 'require';
				  }
				| {
						/** @constant */
						mode: 'verify-ca';
						/** @description PEM CA bundle to trust, written into the session */
						ca_bundle?: string;
						/** @description Absolute path to a CA bundle the runtime already ships (default /etc/ssl/certs/ca-certificates.crt) */
						ca_path?: string;
				  }
				| {
						/** @constant */
						mode: 'verify-full';
						/** @description PEM CA bundle to trust, written into the session */
						ca_bundle?: string;
						/** @description Absolute path to a CA bundle the runtime already ships (default /etc/ssl/certs/ca-certificates.crt) */
						ca_path?: string;
				  };
			/**
			 * @description Automatically offer this connection in marimo's data-source discovery by exporting PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, and PGSSLMODE. If multiple integrations request the same variables, one is discovered and every connection remains available through its notebook snippet.
			 * @default true
			 */
			ambient_env: boolean;
		};
		pyspark: {
			host: string;
			/** @default 15002 */
			port?: number;
			/** @default true */
			use_ssl?: boolean;
			/**
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			auth?:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'token';
						token: SecretInput;
				  };
			user_id?: string;
			user_agent?: string;
			app_name?: string;
			/**
			 * @default {
			 *       "enabled": true,
			 *       "time_ms": 60000,
			 *       "timeout_ms": 20000,
			 *       "without_calls": true
			 *     }
			 */
			keepalive?: {
				/** @default true */
				enabled?: boolean;
				/** @default 60000 */
				time_ms?: number;
				/** @default 20000 */
				timeout_ms?: number;
				/** @default true */
				without_calls?: boolean;
			};
			/** @default [] */
			metadata?: {
				name: string;
				value: SecretInput;
			}[];
			/** @default {} */
			spark_config?: {
				[key: string]: string;
			};
			/** @default [] */
			secret_spark_config?: {
				name: string;
				value: SecretInput;
			}[];
			/**
			 * @description Automatically offer this connection in marimo's data-source discovery by exporting SPARK_REMOTE. If multiple integrations request the same variables, one is discovered and every connection remains available through its notebook snippet.
			 * @default true
			 */
			ambient_env?: boolean;
		};
		pyspark_stored: {
			host: string;
			/** @default 15002 */
			port: number;
			/** @default true */
			use_ssl: boolean;
			/**
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			auth:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'token';
						token: SecretInput;
				  };
			user_id?: string;
			user_agent?: string;
			app_name?: string;
			/**
			 * @default {
			 *       "enabled": true,
			 *       "time_ms": 60000,
			 *       "timeout_ms": 20000,
			 *       "without_calls": true
			 *     }
			 */
			keepalive: {
				/** @default true */
				enabled: boolean;
				/** @default 60000 */
				time_ms: number;
				/** @default 20000 */
				timeout_ms: number;
				/** @default true */
				without_calls: boolean;
			};
			/** @default [] */
			metadata: {
				name: string;
				value: SecretInput;
			}[];
			/** @default {} */
			spark_config: {
				[key: string]: string;
			};
			/** @default [] */
			secret_spark_config: {
				name: string;
				value: SecretInput;
			}[];
			/**
			 * @description Automatically offer this connection in marimo's data-source discovery by exporting SPARK_REMOTE. If multiple integrations request the same variables, one is discovered and every connection remains available through its notebook snippet.
			 * @default true
			 */
			ambient_env: boolean;
		};
		python_package_index: {
			/**
			 * Format: uri
			 * @description Full Python simple-index URL, including its path
			 */
			url: string & (unknown & unknown & unknown);
			/**
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			auth?:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'basic';
						username: string;
						/** @description Password or access token */
						password: SecretInput;
				  };
			/**
			 * @description Replace public PyPI with this repository
			 * @default false
			 */
			default_index?: boolean;
		};
		python_package_index_stored: {
			/**
			 * Format: uri
			 * @description Full Python simple-index URL, including its path
			 */
			url: string & (unknown & unknown & unknown);
			/**
			 * @default {
			 *       "method": "none"
			 *     }
			 */
			auth:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'basic';
						username: string;
						/** @description Password or access token */
						password: SecretInput;
				  };
			/**
			 * @description Replace public PyPI with this repository
			 * @default false
			 */
			default_index: boolean;
		};
		redshift: {
			/** @description Cluster or workgroup endpoint, e.g. wg.123456789012.us-east-1.redshift-serverless.amazonaws.com */
			host: string;
			/** @default 5439 */
			port?: number;
			database: string;
			username: string;
			/** @description Password for the database user */
			password: SecretInput;
			/**
			 * @default verify-ca
			 * @enum {string}
			 */
			ssl_mode?: 'verify-ca' | 'verify-full';
		};
		redshift_stored: {
			/** @description Cluster or workgroup endpoint, e.g. wg.123456789012.us-east-1.redshift-serverless.amazonaws.com */
			host: string;
			/** @default 5439 */
			port: number;
			database: string;
			username: string;
			/** @description Password for the database user */
			password: SecretInput;
			/**
			 * @default verify-ca
			 * @enum {string}
			 */
			ssl_mode: 'verify-ca' | 'verify-full';
		};
		s3: {
			/**
			 * @description Allow managers to upload objects with integration credentials. Server ambient credentials cannot write.
			 * @default false
			 */
			allow_write?: boolean;
			/** @description Default bucket for notebook code; the credentials are not restricted to it */
			bucket?: string;
			/** @description Region name, e.g. us-east-1 */
			region?: string;
			/**
			 * Format: uri
			 * @description S3-compatible endpoint, e.g. https://minio.internal:9000; omit for AWS S3
			 */
			endpoint_url?: string;
			/**
			 * @description Allow http:// endpoints to carry credentials — local development only
			 * @default false
			 */
			allow_insecure_transport?: boolean;
			/**
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			auth?:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'static';
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'anonymous';
				  };
			/**
			 * @description Address buckets as `endpoint/bucket`, which most S3-compatible stores require
			 * @default false
			 */
			path_style?: boolean;
			/**
			 * @description S3 bucket prefixes the guarded DuckDB broker may read
			 * @default []
			 */
			broker_read_locations?: {
				bucket: string;
				prefix: string;
			}[];
			/**
			 * @description Export shared vendor variables for automatic connections. Conflicting values prevent notebook startup.
			 * @default true
			 */
			ambient_env?: boolean;
		};
		s3_stored: {
			/**
			 * @description Allow managers to upload objects with integration credentials. Server ambient credentials cannot write.
			 * @default false
			 */
			allow_write: boolean;
			/** @description Default bucket for notebook code; the credentials are not restricted to it */
			bucket?: string;
			/** @description Region name, e.g. us-east-1 */
			region?: string;
			/**
			 * Format: uri
			 * @description S3-compatible endpoint, e.g. https://minio.internal:9000; omit for AWS S3
			 */
			endpoint_url?: string;
			/**
			 * @description Allow http:// endpoints to carry credentials — local development only
			 * @default false
			 */
			allow_insecure_transport: boolean;
			/**
			 * @default {
			 *       "method": "ambient"
			 *     }
			 */
			auth:
				| {
						/** @constant */
						method: 'ambient';
				  }
				| {
						/** @constant */
						method: 'static';
						access_key_id: SecretInput;
						secret_access_key: SecretInput;
						session_token?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'anonymous';
				  };
			/**
			 * @description Address buckets as `endpoint/bucket`, which most S3-compatible stores require
			 * @default false
			 */
			path_style: boolean;
			/**
			 * @description S3 bucket prefixes the guarded DuckDB broker may read
			 * @default []
			 */
			broker_read_locations: {
				bucket: string;
				prefix: string;
			}[];
			/**
			 * @description Export shared vendor variables for automatic connections. Conflicting values prevent notebook startup.
			 * @default true
			 */
			ambient_env: boolean;
		};
		snowflake: {
			/** @description Account identifier, e.g. myorg-account1 */
			account: string;
			user: string;
			auth:
				| {
						/** @constant */
						method: 'password';
						password: SecretInput;
				  }
				| {
						/** @constant */
						method: 'key_pair';
						/** @description PKCS#8 private key PEM, written into the session */
						private_key: SecretInput;
						private_key_passphrase?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'oauth';
						token: SecretInput;
				  };
			/** @description Warehouse the session runs on */
			warehouse?: string;
			/** @description Session default database */
			database?: string;
			/** @description Session default schema */
			schema?: string;
			/** @description Role the session assumes */
			role?: string;
		};
		snowflake_stored: {
			/** @description Account identifier, e.g. myorg-account1 */
			account: string;
			user: string;
			auth:
				| {
						/** @constant */
						method: 'password';
						password: SecretInput;
				  }
				| {
						/** @constant */
						method: 'key_pair';
						/** @description PKCS#8 private key PEM, written into the session */
						private_key: SecretInput;
						private_key_passphrase?: SecretInput;
				  }
				| {
						/** @constant */
						method: 'oauth';
						token: SecretInput;
				  };
			/** @description Warehouse the session runs on */
			warehouse?: string;
			/** @description Session default database */
			database?: string;
			/** @description Session default schema */
			schema?: string;
			/** @description Role the session assumes */
			role?: string;
		};
		sqlserver: {
			/** @description Server hostname, e.g. mssql.internal */
			host: string;
			/** @default 1433 */
			port?: number;
			database: string;
			username: string;
			/** @description Password for the database user */
			password: SecretInput;
			/**
			 * @default {
			 *       "name": "pyodbc",
			 *       "odbc_driver": "ODBC Driver 18 for SQL Server",
			 *       "encrypt": true,
			 *       "trust_server_certificate": false
			 *     }
			 */
			driver?:
				| {
						/** @constant */
						name: 'pyodbc';
						/**
						 * @description Must be installed in the sandbox image
						 * @default ODBC Driver 18 for SQL Server
						 */
						odbc_driver?: string;
						/** @default true */
						encrypt?: boolean;
						/**
						 * @description Accept any server certificate — encrypts without authenticating
						 * @default false
						 */
						trust_server_certificate?: boolean;
				  }
				| {
						/** @constant */
						name: 'pymssql';
				  };
		};
		sqlserver_stored: {
			/** @description Server hostname, e.g. mssql.internal */
			host: string;
			/** @default 1433 */
			port: number;
			database: string;
			username: string;
			/** @description Password for the database user */
			password: SecretInput;
			/**
			 * @default {
			 *       "name": "pyodbc",
			 *       "odbc_driver": "ODBC Driver 18 for SQL Server",
			 *       "encrypt": true,
			 *       "trust_server_certificate": false
			 *     }
			 */
			driver:
				| {
						/** @constant */
						name: 'pyodbc';
						/**
						 * @description Must be installed in the sandbox image
						 * @default ODBC Driver 18 for SQL Server
						 */
						odbc_driver: string;
						/** @default true */
						encrypt: boolean;
						/**
						 * @description Accept any server certificate — encrypts without authenticating
						 * @default false
						 */
						trust_server_certificate: boolean;
				  }
				| {
						/** @constant */
						name: 'pymssql';
				  };
		};
		startup_script: {
			/** @description POSIX shell script run with sh -e from the workspace root. Maximum 65536 UTF-8 bytes. */
			script: string;
		};
		startup_script_stored: {
			/** @description POSIX shell script run with sh -e from the workspace root. Maximum 65536 UTF-8 bytes. */
			script: string;
		};
		trino: {
			/** @description Coordinator hostname, e.g. trino.internal */
			host: string;
			/** @default 443 */
			port?: number;
			/**
			 * @default https
			 * @enum {string}
			 */
			http_scheme?: 'https' | 'http';
			/** @description Query user; defaults to the signed-in user */
			user?: string;
			auth:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'basic';
						username: string;
						password: SecretInput;
				  }
				| {
						/** @constant */
						method: 'jwt';
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'oauth2';
				  }
				| {
						/** @constant */
						method: 'certificate';
						client_certificate: string;
						client_key: SecretInput;
				  }
				| {
						/** @constant */
						method: 'kerberos';
						krb5_config?: string;
						service_name?: string;
						/**
						 * @default required
						 * @enum {string}
						 */
						mutual_authentication?: 'required' | 'optional' | 'disabled';
						/** @default false */
						force_preemptive?: boolean;
						hostname_override?: string;
						/** @default true */
						sanitize_mutual_error_response?: boolean;
						principal?: string;
						/** @default false */
						delegate?: boolean;
				  }
				| {
						/** @constant */
						method: 'gssapi';
						krb5_config?: string;
						service_name?: string;
						/**
						 * @default disabled
						 * @enum {string}
						 */
						mutual_authentication?: 'required' | 'optional' | 'disabled';
						/** @default false */
						force_preemptive?: boolean;
						hostname_override?: string;
						/** @default true */
						sanitize_mutual_error_response?: boolean;
						principal?: string;
						/** @default false */
						delegate?: boolean;
				  };
			/**
			 * @default {
			 *       "verification": "system"
			 *     }
			 */
			tls?:
				| {
						/** @constant */
						verification: 'system';
				  }
				| {
						/** @constant */
						verification: 'disabled';
				  }
				| {
						/** @constant */
						verification: 'custom_ca';
						ca_bundle: string;
				  };
			/** @description Default catalog; required for automatic marimo data-source discovery */
			default_catalog?: string;
			default_schema?: string;
			source?: string;
			/** @default {} */
			session_properties?: {
				[key: string]: string;
			};
			/** @default {} */
			roles?: {
				[key: string]: string;
			};
			/** @default [] */
			client_tags?: {
				value: string;
			}[];
			/** @default [] */
			http_headers?: {
				/** @description HTTP header name */
				name: string;
				/** @description Header value, stored as a secret */
				value: SecretInput;
			}[];
			/** @default [] */
			extra_credentials?: {
				name: string;
				value: SecretInput;
			}[];
			timezone?: string;
			encoding?: {
				/** @enum {string} */
				value: 'json' | 'json+lz4' | 'json+zstd';
			}[];
			max_attempts?: number;
			request_timeout_seconds?: number;
			heartbeat_interval_seconds?: number;
			/**
			 * @default AUTOCOMMIT
			 * @enum {string}
			 */
			isolation_level?:
				| 'AUTOCOMMIT'
				| 'READ_UNCOMMITTED'
				| 'READ_COMMITTED'
				| 'REPEATABLE_READ'
				| 'SERIALIZABLE';
			/** @default false */
			legacy_primitive_types?: boolean;
			legacy_prepared_statements?: boolean;
			/**
			 * @description Automatically offer this connection in marimo's data-source discovery by exporting TRINO_HOST, TRINO_PORT, TRINO_USER, TRINO_CATALOG, and TRINO_PASSWORD. If multiple integrations request the same variables, one is discovered and every connection remains available through its notebook snippet.
			 * @default true
			 */
			ambient_env?: boolean;
		};
		trino_stored: {
			/** @description Coordinator hostname, e.g. trino.internal */
			host: string;
			/** @default 443 */
			port: number;
			/**
			 * @default https
			 * @enum {string}
			 */
			http_scheme: 'https' | 'http';
			/** @description Query user; defaults to the signed-in user */
			user?: string;
			auth:
				| {
						/** @constant */
						method: 'none';
				  }
				| {
						/** @constant */
						method: 'basic';
						username: string;
						password: SecretInput;
				  }
				| {
						/** @constant */
						method: 'jwt';
						token: SecretInput;
				  }
				| {
						/** @constant */
						method: 'oauth2';
				  }
				| {
						/** @constant */
						method: 'certificate';
						client_certificate: string;
						client_key: SecretInput;
				  }
				| {
						/** @constant */
						method: 'kerberos';
						krb5_config?: string;
						service_name?: string;
						/**
						 * @default required
						 * @enum {string}
						 */
						mutual_authentication: 'required' | 'optional' | 'disabled';
						/** @default false */
						force_preemptive: boolean;
						hostname_override?: string;
						/** @default true */
						sanitize_mutual_error_response: boolean;
						principal?: string;
						/** @default false */
						delegate: boolean;
				  }
				| {
						/** @constant */
						method: 'gssapi';
						krb5_config?: string;
						service_name?: string;
						/**
						 * @default disabled
						 * @enum {string}
						 */
						mutual_authentication: 'required' | 'optional' | 'disabled';
						/** @default false */
						force_preemptive: boolean;
						hostname_override?: string;
						/** @default true */
						sanitize_mutual_error_response: boolean;
						principal?: string;
						/** @default false */
						delegate: boolean;
				  };
			/**
			 * @default {
			 *       "verification": "system"
			 *     }
			 */
			tls:
				| {
						/** @constant */
						verification: 'system';
				  }
				| {
						/** @constant */
						verification: 'disabled';
				  }
				| {
						/** @constant */
						verification: 'custom_ca';
						ca_bundle: string;
				  };
			/** @description Default catalog; required for automatic marimo data-source discovery */
			default_catalog?: string;
			default_schema?: string;
			source?: string;
			/** @default {} */
			session_properties: {
				[key: string]: string;
			};
			/** @default {} */
			roles: {
				[key: string]: string;
			};
			/** @default [] */
			client_tags: {
				value: string;
			}[];
			/** @default [] */
			http_headers: {
				/** @description HTTP header name */
				name: string;
				/** @description Header value, stored as a secret */
				value: SecretInput;
			}[];
			/** @default [] */
			extra_credentials: {
				name: string;
				value: SecretInput;
			}[];
			timezone?: string;
			encoding?: {
				/** @enum {string} */
				value: 'json' | 'json+lz4' | 'json+zstd';
			}[];
			max_attempts?: number;
			request_timeout_seconds?: number;
			heartbeat_interval_seconds?: number;
			/**
			 * @default AUTOCOMMIT
			 * @enum {string}
			 */
			isolation_level:
				| 'AUTOCOMMIT'
				| 'READ_UNCOMMITTED'
				| 'READ_COMMITTED'
				| 'REPEATABLE_READ'
				| 'SERIALIZABLE';
			/** @default false */
			legacy_primitive_types: boolean;
			legacy_prepared_statements?: boolean;
			/**
			 * @description Automatically offer this connection in marimo's data-source discovery by exporting TRINO_HOST, TRINO_PORT, TRINO_USER, TRINO_CATALOG, and TRINO_PASSWORD. If multiple integrations request the same variables, one is discovered and every connection remains available through its notebook snippet.
			 * @default true
			 */
			ambient_env: boolean;
		};
		wandb: {
			/** @description API key from wandb.ai/authorize */
			api_key: SecretInput;
			/**
			 * Format: uri
			 * @description Set this for a self-hosted or dedicated-cloud deployment
			 * @default https://api.wandb.ai
			 */
			base_url?: string;
			/** @description Default team or user */
			entity?: string;
			project?: string;
			/**
			 * @description `offline` records runs to disk without contacting the server
			 * @default online
			 * @enum {string}
			 */
			mode?: 'online' | 'offline';
		};
		wandb_stored: {
			/** @description API key from wandb.ai/authorize */
			api_key: SecretInput;
			/**
			 * Format: uri
			 * @description Set this for a self-hosted or dedicated-cloud deployment
			 * @default https://api.wandb.ai
			 */
			base_url: string;
			/** @description Default team or user */
			entity?: string;
			project?: string;
			/**
			 * @description `offline` records runs to disk without contacting the server
			 * @default online
			 * @enum {string}
			 */
			mode: 'online' | 'offline';
		};
		/**
		 * @default {
		 *       "scheme": "catalog"
		 *     }
		 */
		IcebergStorage:
			| {
					/** @constant */
					scheme: 'catalog';
			  }
			| {
					/** @constant */
					scheme: 's3';
					region?: string;
					/** Format: uri */
					endpoint?: string;
					/**
					 * @description Credentials for S3 FileIO only; these override client credentials
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					credentials?:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'static';
								access_key_id: SecretInput;
								secret_access_key: SecretInput;
								session_token?: SecretInput;
						  }
						| {
								/** @constant */
								method: 'profile';
								profile_name: string;
						  };
					role_arn?: string;
					role_session_name?: string;
					signer?: string;
					/** Format: uri */
					signer_uri?: string;
					signer_endpoint?: string;
					/** @default false */
					resolve_region?: boolean;
					/** Format: uri */
					proxy_uri?: string;
					connect_timeout?: number;
					request_timeout?: number;
					/** @default false */
					force_virtual_addressing?: boolean;
					/** @default false */
					anonymous?: boolean;
			  }
			| {
					/** @constant */
					scheme: 'gcs';
					project_id?: string;
					/**
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					auth?:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'oauth_token';
								token: SecretInput;
								token_expires_at_ms?: number;
						  };
					/**
					 * @default full_control
					 * @enum {string}
					 */
					access?: 'read_only' | 'read_write' | 'full_control';
					/**
					 * @default none
					 * @enum {string}
					 */
					consistency?: 'none' | 'size' | 'md5';
					cache_timeout?: number;
					/** @default false */
					requester_pays?: boolean;
					/** @default {} */
					session_kwargs?: {
						[key: string]: string;
					};
					/** Format: uri */
					service_host?: string;
					default_location?: string;
					/** @default false */
					version_aware?: boolean;
			  }
			| {
					/** @constant */
					scheme: 'adls';
					account_name?: string;
					/**
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					auth?:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'connection_string';
								connection_string: SecretInput;
						  }
						| {
								/** @constant */
								method: 'account_key';
								account_key: SecretInput;
						  }
						| {
								/** @constant */
								method: 'sas_token';
								sas_token: SecretInput;
						  }
						| {
								/** @constant */
								method: 'service_principal';
								tenant_id: string;
								client_id: string;
								client_secret: SecretInput;
						  }
						| {
								/** @constant */
								method: 'access_token';
								token: SecretInput;
						  }
						| {
								/** @constant */
								method: 'credential';
								credential: SecretInput;
						  };
					account_host?: string;
					blob_storage_authority?: string;
					dfs_storage_authority?: string;
					/**
					 * @default https
					 * @enum {string}
					 */
					blob_storage_scheme?: 'http' | 'https';
					/**
					 * @default https
					 * @enum {string}
					 */
					dfs_storage_scheme?: 'http' | 'https';
			  }
			| {
					/** @constant */
					scheme: 'hdfs';
					host: string;
					/** @default 8020 */
					port?: number;
					user?: string;
					kerberos_ticket?: string;
			  }
			| {
					/** @constant */
					scheme: 'hugging_face';
					/**
					 * Format: uri
					 * @default https://huggingface.co
					 */
					endpoint?: string;
					token?: SecretInput;
			  };
		/**
		 * @default {
		 *       "scheme": "catalog"
		 *     }
		 */
		IcebergRestStorage:
			| {
					/** @constant */
					scheme: 'catalog';
					vended_s3?: {
						/** Format: uri */
						endpoint: string;
						/** @default us-east-1 */
						region?: string;
						/** @default false */
						force_virtual_addressing?: boolean;
						allowed_locations: {
							bucket: string;
							prefix: string;
						}[];
					};
			  }
			| {
					/** @constant */
					scheme: 's3';
					region?: string;
					/** Format: uri */
					endpoint?: string;
					/**
					 * @description Credentials for S3 FileIO only; these override client credentials
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					credentials?:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'static';
								access_key_id: SecretInput;
								secret_access_key: SecretInput;
								session_token?: SecretInput;
						  }
						| {
								/** @constant */
								method: 'profile';
								profile_name: string;
						  };
					role_arn?: string;
					role_session_name?: string;
					signer?: string;
					/** Format: uri */
					signer_uri?: string;
					signer_endpoint?: string;
					/** @default false */
					resolve_region?: boolean;
					/** Format: uri */
					proxy_uri?: string;
					connect_timeout?: number;
					request_timeout?: number;
					/** @default false */
					force_virtual_addressing?: boolean;
					/** @default false */
					anonymous?: boolean;
					/**
					 * @description S3 bucket prefixes the guarded DuckDB broker may read
					 * @default []
					 */
					broker_read_locations?: {
						bucket: string;
						prefix: string;
					}[];
			  }
			| {
					/** @constant */
					scheme: 'gcs';
					project_id?: string;
					/**
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					auth?:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'oauth_token';
								token: SecretInput;
								token_expires_at_ms?: number;
						  };
					/**
					 * @default full_control
					 * @enum {string}
					 */
					access?: 'read_only' | 'read_write' | 'full_control';
					/**
					 * @default none
					 * @enum {string}
					 */
					consistency?: 'none' | 'size' | 'md5';
					cache_timeout?: number;
					/** @default false */
					requester_pays?: boolean;
					/** @default {} */
					session_kwargs?: {
						[key: string]: string;
					};
					/** Format: uri */
					service_host?: string;
					default_location?: string;
					/** @default false */
					version_aware?: boolean;
			  }
			| {
					/** @constant */
					scheme: 'adls';
					account_name?: string;
					/**
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					auth?:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'connection_string';
								connection_string: SecretInput;
						  }
						| {
								/** @constant */
								method: 'account_key';
								account_key: SecretInput;
						  }
						| {
								/** @constant */
								method: 'sas_token';
								sas_token: SecretInput;
						  }
						| {
								/** @constant */
								method: 'service_principal';
								tenant_id: string;
								client_id: string;
								client_secret: SecretInput;
						  }
						| {
								/** @constant */
								method: 'access_token';
								token: SecretInput;
						  }
						| {
								/** @constant */
								method: 'credential';
								credential: SecretInput;
						  };
					account_host?: string;
					blob_storage_authority?: string;
					dfs_storage_authority?: string;
					/**
					 * @default https
					 * @enum {string}
					 */
					blob_storage_scheme?: 'http' | 'https';
					/**
					 * @default https
					 * @enum {string}
					 */
					dfs_storage_scheme?: 'http' | 'https';
			  }
			| {
					/** @constant */
					scheme: 'hdfs';
					host: string;
					/** @default 8020 */
					port?: number;
					user?: string;
					kerberos_ticket?: string;
			  }
			| {
					/** @constant */
					scheme: 'hugging_face';
					/**
					 * Format: uri
					 * @default https://huggingface.co
					 */
					endpoint?: string;
					token?: SecretInput;
			  };
		/** @default {} */
		IcebergRuntime: {
			max_workers?: number;
			legacy_current_snapshot_id?: boolean;
			downcast_ns_timestamp_to_us_on_write?: boolean;
			pyarrow_use_large_types_on_read?: boolean;
		};
		/**
		 * @description Raw PyIceberg catalog properties not represented by typed fields
		 * @default {}
		 */
		IcebergExtraProperties: {
			[key: string]: string;
		};
		/**
		 * @default {
		 *       "scheme": "catalog"
		 *     }
		 */
		IcebergStorageStored:
			| {
					/** @constant */
					scheme: 'catalog';
			  }
			| {
					/** @constant */
					scheme: 's3';
					region?: string;
					/** Format: uri */
					endpoint?: string;
					/**
					 * @description Credentials for S3 FileIO only; these override client credentials
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					credentials:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'static';
								access_key_id: SecretInput;
								secret_access_key: SecretInput;
								session_token?: SecretInput;
						  }
						| {
								/** @constant */
								method: 'profile';
								profile_name: string;
						  };
					role_arn?: string;
					role_session_name?: string;
					signer?: string;
					/** Format: uri */
					signer_uri?: string;
					signer_endpoint?: string;
					/** @default false */
					resolve_region: boolean;
					/** Format: uri */
					proxy_uri?: string;
					connect_timeout?: number;
					request_timeout?: number;
					/** @default false */
					force_virtual_addressing: boolean;
					/** @default false */
					anonymous: boolean;
			  }
			| {
					/** @constant */
					scheme: 'gcs';
					project_id?: string;
					/**
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					auth:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'oauth_token';
								token: SecretInput;
								token_expires_at_ms?: number;
						  };
					/**
					 * @default full_control
					 * @enum {string}
					 */
					access: 'read_only' | 'read_write' | 'full_control';
					/**
					 * @default none
					 * @enum {string}
					 */
					consistency: 'none' | 'size' | 'md5';
					cache_timeout?: number;
					/** @default false */
					requester_pays: boolean;
					/** @default {} */
					session_kwargs: {
						[key: string]: string;
					};
					/** Format: uri */
					service_host?: string;
					default_location?: string;
					/** @default false */
					version_aware: boolean;
			  }
			| {
					/** @constant */
					scheme: 'adls';
					account_name?: string;
					/**
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					auth:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'connection_string';
								connection_string: SecretInput;
						  }
						| {
								/** @constant */
								method: 'account_key';
								account_key: SecretInput;
						  }
						| {
								/** @constant */
								method: 'sas_token';
								sas_token: SecretInput;
						  }
						| {
								/** @constant */
								method: 'service_principal';
								tenant_id: string;
								client_id: string;
								client_secret: SecretInput;
						  }
						| {
								/** @constant */
								method: 'access_token';
								token: SecretInput;
						  }
						| {
								/** @constant */
								method: 'credential';
								credential: SecretInput;
						  };
					account_host?: string;
					blob_storage_authority?: string;
					dfs_storage_authority?: string;
					/**
					 * @default https
					 * @enum {string}
					 */
					blob_storage_scheme: 'http' | 'https';
					/**
					 * @default https
					 * @enum {string}
					 */
					dfs_storage_scheme: 'http' | 'https';
			  }
			| {
					/** @constant */
					scheme: 'hdfs';
					host: string;
					/** @default 8020 */
					port: number;
					user?: string;
					kerberos_ticket?: string;
			  }
			| {
					/** @constant */
					scheme: 'hugging_face';
					/**
					 * Format: uri
					 * @default https://huggingface.co
					 */
					endpoint: string;
					token?: SecretInput;
			  };
		/**
		 * @default {
		 *       "scheme": "catalog"
		 *     }
		 */
		IcebergRestStorageStored:
			| {
					/** @constant */
					scheme: 'catalog';
					vended_s3?: {
						/** Format: uri */
						endpoint: string;
						/** @default us-east-1 */
						region: string;
						/** @default false */
						force_virtual_addressing: boolean;
						allowed_locations: {
							bucket: string;
							prefix: string;
						}[];
					};
			  }
			| {
					/** @constant */
					scheme: 's3';
					region?: string;
					/** Format: uri */
					endpoint?: string;
					/**
					 * @description Credentials for S3 FileIO only; these override client credentials
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					credentials:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'static';
								access_key_id: SecretInput;
								secret_access_key: SecretInput;
								session_token?: SecretInput;
						  }
						| {
								/** @constant */
								method: 'profile';
								profile_name: string;
						  };
					role_arn?: string;
					role_session_name?: string;
					signer?: string;
					/** Format: uri */
					signer_uri?: string;
					signer_endpoint?: string;
					/** @default false */
					resolve_region: boolean;
					/** Format: uri */
					proxy_uri?: string;
					connect_timeout?: number;
					request_timeout?: number;
					/** @default false */
					force_virtual_addressing: boolean;
					/** @default false */
					anonymous: boolean;
					/**
					 * @description S3 bucket prefixes the guarded DuckDB broker may read
					 * @default []
					 */
					broker_read_locations: {
						bucket: string;
						prefix: string;
					}[];
			  }
			| {
					/** @constant */
					scheme: 'gcs';
					project_id?: string;
					/**
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					auth:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'oauth_token';
								token: SecretInput;
								token_expires_at_ms?: number;
						  };
					/**
					 * @default full_control
					 * @enum {string}
					 */
					access: 'read_only' | 'read_write' | 'full_control';
					/**
					 * @default none
					 * @enum {string}
					 */
					consistency: 'none' | 'size' | 'md5';
					cache_timeout?: number;
					/** @default false */
					requester_pays: boolean;
					/** @default {} */
					session_kwargs: {
						[key: string]: string;
					};
					/** Format: uri */
					service_host?: string;
					default_location?: string;
					/** @default false */
					version_aware: boolean;
			  }
			| {
					/** @constant */
					scheme: 'adls';
					account_name?: string;
					/**
					 * @default {
					 *       "method": "ambient"
					 *     }
					 */
					auth:
						| {
								/** @constant */
								method: 'ambient';
						  }
						| {
								/** @constant */
								method: 'connection_string';
								connection_string: SecretInput;
						  }
						| {
								/** @constant */
								method: 'account_key';
								account_key: SecretInput;
						  }
						| {
								/** @constant */
								method: 'sas_token';
								sas_token: SecretInput;
						  }
						| {
								/** @constant */
								method: 'service_principal';
								tenant_id: string;
								client_id: string;
								client_secret: SecretInput;
						  }
						| {
								/** @constant */
								method: 'access_token';
								token: SecretInput;
						  }
						| {
								/** @constant */
								method: 'credential';
								credential: SecretInput;
						  };
					account_host?: string;
					blob_storage_authority?: string;
					dfs_storage_authority?: string;
					/**
					 * @default https
					 * @enum {string}
					 */
					blob_storage_scheme: 'http' | 'https';
					/**
					 * @default https
					 * @enum {string}
					 */
					dfs_storage_scheme: 'http' | 'https';
			  }
			| {
					/** @constant */
					scheme: 'hdfs';
					host: string;
					/** @default 8020 */
					port: number;
					user?: string;
					kerberos_ticket?: string;
			  }
			| {
					/** @constant */
					scheme: 'hugging_face';
					/**
					 * Format: uri
					 * @default https://huggingface.co
					 */
					endpoint: string;
					token?: SecretInput;
			  };
		/** @default {} */
		IcebergRuntimeStored: {
			max_workers?: number;
			legacy_current_snapshot_id?: boolean;
			downcast_ns_timestamp_to_us_on_write?: boolean;
			pyarrow_use_large_types_on_read?: boolean;
		};
		/**
		 * @description Raw PyIceberg catalog properties not represented by typed fields
		 * @default {}
		 */
		IcebergExtraPropertiesStored: {
			[key: string]: string;
		};
	};
	responses: never;
	parameters: never;
	requestBodies: never;
	headers: never;
	pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
	read_agent_context_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['agent_context_stored'];
				};
			};
		};
	};
	write_agent_context_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['agent_context'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_athena_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['athena_stored'];
				};
			};
		};
	};
	write_athena_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['athena'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_aws_codeartifact_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['aws_codeartifact_stored'];
				};
			};
		};
	};
	write_aws_codeartifact_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['aws_codeartifact'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_azure_artifacts_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['azure_artifacts_stored'];
				};
			};
		};
	};
	write_azure_artifacts_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['azure_artifacts'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_azure_blob_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['azure_blob_stored'];
				};
			};
		};
	};
	write_azure_blob_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['azure_blob'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_bigquery_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['bigquery_stored'];
				};
			};
		};
	};
	write_bigquery_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['bigquery'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_clickhouse_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['clickhouse_stored'];
				};
			};
		};
	};
	write_clickhouse_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['clickhouse'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_custom_css_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['custom_css_stored'];
				};
			};
		};
	};
	write_custom_css_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['custom_css'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_custom_env_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['custom_env_stored'];
				};
			};
		};
	};
	write_custom_env_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['custom_env'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_databricks_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['databricks_stored'];
				};
			};
		};
	};
	write_databricks_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['databricks'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_duckdb_http_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['duckdb_http_stored'];
				};
			};
		};
	};
	write_duckdb_http_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['duckdb_http'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_ducklake_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['ducklake_stored'];
				};
			};
		};
	};
	write_ducklake_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['ducklake'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_gcs_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['gcs_stored'];
				};
			};
		};
	};
	write_gcs_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['gcs'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_gitlab_packages_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['gitlab_packages_stored'];
				};
			};
		};
	};
	write_gitlab_packages_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['gitlab_packages'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_html_head_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['html_head_stored'];
				};
			};
		};
	};
	write_html_head_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['html_head'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_huggingface_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['huggingface_stored'];
				};
			};
		};
	};
	write_huggingface_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['huggingface'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_iceberg_bigquery_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['iceberg_bigquery_stored'];
				};
			};
		};
	};
	write_iceberg_bigquery_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['iceberg_bigquery'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_iceberg_dynamodb_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['iceberg_dynamodb_stored'];
				};
			};
		};
	};
	write_iceberg_dynamodb_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['iceberg_dynamodb'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_iceberg_glue_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['iceberg_glue_stored'];
				};
			};
		};
	};
	write_iceberg_glue_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['iceberg_glue'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_iceberg_hive_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['iceberg_hive_stored'];
				};
			};
		};
	};
	write_iceberg_hive_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['iceberg_hive'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_iceberg_rest_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['iceberg_rest_stored'];
				};
			};
		};
	};
	write_iceberg_rest_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['iceberg_rest'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_iceberg_sql_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['iceberg_sql_stored'];
				};
			};
		};
	};
	write_iceberg_sql_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['iceberg_sql'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_jfrog_artifactory_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['jfrog_artifactory_stored'];
				};
			};
		};
	};
	write_jfrog_artifactory_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['jfrog_artifactory'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_marimo_studio_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['marimo_studio_stored'];
				};
			};
		};
	};
	write_marimo_studio_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['marimo_studio'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_mongodb_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['mongodb_stored'];
				};
			};
		};
	};
	write_mongodb_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['mongodb'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_motherduck_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['motherduck_stored'];
				};
			};
		};
	};
	write_motherduck_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['motherduck'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_mysql_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['mysql_stored'];
				};
			};
		};
	};
	write_mysql_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['mysql'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_otlp_logs_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['otlp_logs_stored'];
				};
			};
		};
	};
	write_otlp_logs_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['otlp_logs'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_postgres_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['postgres_stored'];
				};
			};
		};
	};
	write_postgres_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['postgres'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_pyspark_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['pyspark_stored'];
				};
			};
		};
	};
	write_pyspark_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['pyspark'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_python_package_index_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['python_package_index_stored'];
				};
			};
		};
	};
	write_python_package_index_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['python_package_index'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_redshift_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['redshift_stored'];
				};
			};
		};
	};
	write_redshift_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['redshift'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_s3_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['s3_stored'];
				};
			};
		};
	};
	write_s3_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['s3'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_snowflake_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['snowflake_stored'];
				};
			};
		};
	};
	write_snowflake_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['snowflake'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_sqlserver_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['sqlserver_stored'];
				};
			};
		};
	};
	write_sqlserver_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['sqlserver'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_startup_script_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['startup_script_stored'];
				};
			};
		};
	};
	write_startup_script_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['startup_script'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_trino_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['trino_stored'];
				};
			};
		};
	};
	write_trino_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['trino'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
	read_wandb_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			/** @description A stored config every reader and migration must accept. */
			200: {
				headers: {
					[name: string]: unknown;
				};
				content: {
					'application/json': components['schemas']['wandb_stored'];
				};
			};
		};
	};
	write_wandb_config: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				'application/json': components['schemas']['wandb'];
			};
		};
		responses: {
			/** @description Accepted. */
			204: {
				headers: {
					[name: string]: unknown;
				};
				content?: never;
			};
		};
	};
}

export type IntegrationConfigMap = {
	agent_context: components['schemas']['agent_context'];
	athena: components['schemas']['athena'];
	aws_codeartifact: components['schemas']['aws_codeartifact'];
	azure_artifacts: components['schemas']['azure_artifacts'];
	azure_blob: components['schemas']['azure_blob'];
	bigquery: components['schemas']['bigquery'];
	clickhouse: components['schemas']['clickhouse'];
	custom_css: components['schemas']['custom_css'];
	custom_env: components['schemas']['custom_env'];
	databricks: components['schemas']['databricks'];
	duckdb_http: components['schemas']['duckdb_http'];
	ducklake: components['schemas']['ducklake'];
	gcs: components['schemas']['gcs'];
	gitlab_packages: components['schemas']['gitlab_packages'];
	html_head: components['schemas']['html_head'];
	huggingface: components['schemas']['huggingface'];
	iceberg_bigquery: components['schemas']['iceberg_bigquery'];
	iceberg_dynamodb: components['schemas']['iceberg_dynamodb'];
	iceberg_glue: components['schemas']['iceberg_glue'];
	iceberg_hive: components['schemas']['iceberg_hive'];
	iceberg_rest: components['schemas']['iceberg_rest'];
	iceberg_sql: components['schemas']['iceberg_sql'];
	jfrog_artifactory: components['schemas']['jfrog_artifactory'];
	marimo_studio: components['schemas']['marimo_studio'];
	mongodb: components['schemas']['mongodb'];
	motherduck: components['schemas']['motherduck'];
	mysql: components['schemas']['mysql'];
	otlp_logs: components['schemas']['otlp_logs'];
	postgres: components['schemas']['postgres'];
	pyspark: components['schemas']['pyspark'];
	python_package_index: components['schemas']['python_package_index'];
	redshift: components['schemas']['redshift'];
	s3: components['schemas']['s3'];
	snowflake: components['schemas']['snowflake'];
	sqlserver: components['schemas']['sqlserver'];
	startup_script: components['schemas']['startup_script'];
	trino: components['schemas']['trino'];
	wandb: components['schemas']['wandb'];
};
