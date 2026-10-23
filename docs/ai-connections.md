# AI connections

Open **Settings → AI connection**. The Connection search finds provider names and the models they host in [models.dev](https://models.dev). **ChatGPT subscription** appears first when the search is empty.

For an API provider, enter its API key, search its model list, and select a model. The key stays in memory for the current browser tab and is cleared when changing providers or signing out. It is never saved in kitchen preferences or exports. Requests use that provider's API billing.

Reasoning controls come from the selected model's catalog metadata. Effort levels, thinking toggles, and token budgets only appear when supported by the implemented provider protocol. **Model default** omits an override. Model or provider changes clear reasoning overrides. The server validates overrides against the catalog before inference; generation, recipe import, photo capture, and nutrition all use the selected settings.

Supported integrations include OpenAI, Anthropic, OpenRouter, Google Gemini, Groq, DeepSeek, xAI, Mistral, Cerebras, DeepInfra, Together AI, Fireworks AI, Perplexity, Cohere, NVIDIA, Baseten, and the catalog's OpenAI-compatible API-key providers. Compatible destinations come from a checked-in endpoint snapshot; refresh it with `npm run catalog:update` and review the diff before committing. Runtime catalog data and browser input cannot redirect an API key to an arbitrary endpoint.

Other catalog providers remain searchable but are marked unavailable; cloud-role, regional, and custom-endpoint integrations are not presented as working API-key connections. Unavailable integrations appear only when searching, keeping the initial list focused on usable connections.

Models that only return embeddings/audio/images and deprecated models are excluded. Models without image input can generate recipes and nutrition from text; choose an image-capable model for photos. Catalog membership is not proof that an API key or subscription has entitlement to a model. A live request is the final access check.

ChatGPT uses its authenticated account catalog for selectable models, supplemented with matching models.dev reasoning metadata. It does not use API-key billing. See [ChatGPT authorization](chatgpt-oauth.md) for the Codex device-code trial and the alternative registered SIWC integration. Users never need a local connector or terminal; the app displays a code and an OpenAI authorization link, then saves the connection automatically.
