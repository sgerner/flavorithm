# Voice input

Choose **Settings → Voice input → Transcription**. The same **Use voice** button works in the pantry and recipe import. With a transcription connection, allow microphone access, speak, then choose **Stop recording**. Review the text before submitting it. Recordings stop after two minutes. **Cancel voice**, closing the dialog, signing out, or leaving the page releases the microphone and discards the pending result.

## Options

| Connection        | Setup                                                                                | Cost / availability                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic         | No user setup                                                                        | Uses the installation's local Whisper endpoint if configured, otherwise browser dictation. It does not silently use a paid cloud provider.                 |
| Browser dictation | Allow microphone access                                                              | No Flavorithm API key. Requires browser SpeechRecognition support; Firefox stable may not expose it. The browser may send audio to its own speech service. |
| Local Whisper     | Operator configures the service below                                                | No external transcription bill; operator supplies compute and a Whisper model.                                                                             |
| Groq              | [Create an API key](https://console.groq.com/keys), choose Whisper Turbo or Large v3 | Free plan with account-specific limits. Published paid audio rates: Turbo $0.04/hour; Large v3 $0.111/hour, with a 10-second minimum per request.          |
| Deepgram          | [Create an API key](https://console.deepgram.com/), choose Nova-3 or Nova-2          | Advertises $200 introductory credits, then usage billing. This is not a recurring free allowance. Nova-3 prerecorded monolingual rate is $0.0043/minute.   |

Pricing checked October 22, 2026; eligibility, credits, models, and limits can change. Check [Groq speech pricing](https://console.groq.com/docs/speech-to-text), [Groq account limits](https://console.groq.com/docs/rate-limits), and [Deepgram pricing](https://deepgram.com/pricing) before enabling billing. Groq Turbo is the suggested first cloud option for occasional ingredient dictation.

Provider/model selection is remembered on this device for the signed-in user. Cloud keys stay in tab memory, survive closing Settings, and clear when reloading, switching provider, or signing out. They are not included in household sync, exports, or browser storage. Re-enter the key when opening a new tab. Voice is configured separately from the recipe model; a ChatGPT subscription connection is not used for transcription.

## Local Whisper setup

The endpoint is configured by the operator rather than accepted from browser requests. This permits private Docker/LAN services without giving users a general-purpose server-side URL proxy. The endpoint is called by the Flavorithm server, so `localhost` means the server/container itself, not the user's computer. Use HTTPS for a remote service; plain HTTP is intended for a trusted local container network.

For [whisper.cpp](https://github.com/ggml-org/whisper.cpp), follow its build and model download instructions, then run its [HTTP server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server), for example:

```sh
./build/bin/whisper-server -m models/ggml-base.bin --host 0.0.0.0 --port 8080
```

Use a multilingual model such as `base` for multiple languages, or `base.en` for English only. Start with a small model on CPU and measure speed before choosing a larger one. Keep the service private and run it as an unprivileged user. When both services run in Docker, attach them to a shared private network and use the Whisper service name as the hostname. Do not publish the Whisper port to the internet.

Set in the Flavorithm server environment and restart the app:

```dotenv
WHISPER_TRANSCRIPTION_URL=http://whisper:8080/inference
# Optional for authenticated/OpenAI-compatible Whisper servers:
WHISPER_API_KEY=
WHISPER_MODEL=whisper-1
```

For an OpenAI-compatible local server, set the **full** URL ending in `/v1/audio/transcriptions` instead. The server must accept multipart `file`, `model`, `language`, and `response_format=json`, and return `{ "text": "..." }`. whisper.cpp uses the model loaded by its server; changing `WHISPER_MODEL` does not load a new whisper.cpp model. Requests are converted to mono 16kHz PCM WAV in the browser, so whisper.cpp does not require ffmpeg conversion for these recordings.

Settings will report the local service as available when a valid endpoint is configured; this is configuration detection, not a live health check. Connection failures are reported when recording. For Skynet, preserve both Compose files when restarting:

```sh
docker compose -p flavorithm -f compose.yml -f deploy/skynet/compose.override.yml up -d --no-deps flavorithm
```

## Audio handling and checks

Recording requires microphone permission and HTTPS (localhost is allowed for development). The app chooses a browser-supported recording format, converts it locally, then uploads only on Stop. The server accepts only bounded PCM WAV recordings, authenticates the caller, checks request origin, rate limits to 30 requests per user/hour, validates model selection, rejects redirects, limits upstream responses, and times out after 90 seconds. There is no automatic retry or provider fallback that could create unexpected cloud charges.

Audio is processed in memory and not saved by Flavorithm. Cloud providers receive recordings and language information under their own policies; local Whisper keeps the transcription within the operator's infrastructure. Cancellation stops local capture and prevents late text insertion, but an upstream service may already have processed an upload. The server returns only the transcript and generic actionable errors, not upstream payloads or credentials.

Automated tests mock providers and microphone interfaces. Live cloud transcription requires your own provider key; live local transcription requires a running Whisper service. Both pantry and import transcripts remain editable.
