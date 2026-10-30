// Pi treats provider credentials in the environment, such as GEMINI_API_KEY,
// as connected providers. Tests start without the developer's own; a test that
// needs one stubs it.
const PROVIDER_CREDENTIAL = /_API_KEY$|^AWS_/i;
const PROVIDER_AUTH_ENV = new Set([
  "HF_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
]);

for (const name of Object.keys(process.env)) {
  if (
    PROVIDER_CREDENTIAL.test(name) ||
    PROVIDER_AUTH_ENV.has(name.toUpperCase())
  ) {
    delete process.env[name];
  }
}

// Model catalogs stay offline in tests unless a case explicitly supplies a fake network refresh.
process.env.PI_OFFLINE = "1";
