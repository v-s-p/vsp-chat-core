// Minimal externalized configuration for the P1 validation harness.
// Not a persona/runtime config — just enough to point OpenAICompatibleAdapter
// at a baseURL/model, see docs/DESIGN.md.
export function loadChatConfig(env = process.env) {
  return {
    baseURL: env.CHAT_CORE_BASE_URL || 'http://localhost:11434/v1',
    model: env.CHAT_CORE_MODEL || 'qwen2.5:0.5b',
    apiKey: env.CHAT_CORE_API_KEY || undefined
  };
}

// Server-level options. CLI flags win over env so a Windows user can switch
// provider without shell-specific env syntax:
//   node src/server/server.js --provider chatgpt-plan --persona D:\private\my-persona.md
export const PROVIDERS = Object.freeze(['local', 'chatgpt-plan']);

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

export function loadServerOptions(argv = process.argv.slice(2), env = process.env) {
  const provider = flag(argv, 'provider') || env.CHAT_CORE_PROVIDER || 'local';
  if (!PROVIDERS.includes(provider)) {
    throw new TypeError(`--provider must be one of ${PROVIDERS.join(', ')}`);
  }
  return {
    provider,
    // 8790, not 8787: 8787 is commonly taken by other local services
    // (wrangler dev, HAV's HTTP bridge).
    port: Number(flag(argv, 'port') || env.CHAT_CORE_PORT) || 8790,
    personaFile: flag(argv, 'persona') || env.CHAT_CORE_PERSONA_FILE || undefined,
    planModel: flag(argv, 'model') || env.CHAT_CORE_PLAN_MODEL || undefined
  };
}
