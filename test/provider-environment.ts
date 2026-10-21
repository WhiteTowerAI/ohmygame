// Pi treats provider credentials in the environment, such as GEMINI_API_KEY,
// as connected providers. Tests start without the developer's own; a test that
// needs one stubs it.
const PROVIDER_CREDENTIAL =
  /_API_KEY$|^AWS_|^(HF_TOKEN|COPILOT_GITHUB_TOKEN|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_OAUTH_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT|GOOGLE_CLOUD_LOCATION)$/i;

for (const name of Object.keys(process.env)) {
  if (PROVIDER_CREDENTIAL.test(name)) delete process.env[name];
}
